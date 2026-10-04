// The G3 consistency report (ARCHITECTURE.md §14 G3, TEST-3 card): the qualifying dry run against the backtest
// holdout, through STATS-1b's `gateG3`. It reads the run's state directory (journal, account, ledger, recording) and
// writes only to its own output directory: `counterfactuals.jsonl` (the live-only-vetoed candidates scored as if
// entered, research/counterfactual.ts) and `g3.json` (every input and the gate's result). The run's files are
// never written: a test checks the state directory is byte-identical before and after.
//
// Definitions (DECISIONS "G3 report"):
// - A candidate is a shortlisted mint. Kept: it entered. Its net return is the trade's net lamports over its entry
//   cost, fees included (closed trades only).
// - A live-only veto: a candidate that never entered and was rejected at least once with every typed reason on a
//   live-only input (core/facts/kinds.ts `live-only-veto`: sim, xcheck, exec-health). It counts as vetoed (and
//   eligible) only when the counterfactual shows the strategy would have entered without those checks.
// - The reject mix: one count per never-entered candidate, keyed `gate:code` by the first typed reason of its last reject.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, TRIAL_POLICY, type PolicySession, startSession } from '../../../core/src/config/index.ts';
import { FACT_KINDS } from '../../../core/src/facts/kinds.ts';
import type { FillScenario } from '../../../core/src/fills/index.ts';
import { Ledger, openLedgerReader } from '../../../core/src/ledger/index.ts';
import { type G3Registration, type GateResult, type SampleSummary, gateG3, VETO_COMPOSITE_LEVEL } from '../../../core/src/stats/index.ts';
import { SHORTLIST } from '../engine/strategy.ts';
import { parseTyped, typedText } from '../run/json.ts';
import { PAPER_SCENARIO, strategyConfig } from '../run/settings.ts';
import { type CounterfactualTrade, scoreCounterfactual } from './counterfactual.ts';
import { readRecording } from './recording.ts';

/** Inputs whose facts exist only live (FACT_KINDS `live-only-veto`), by the name typed reasons carry. */
export const LIVE_ONLY_INPUTS: ReadonlySet<string> = new Set(['sim', 'xcheck', 'exec-health']);

/** What BT-2's holdout report gives G3 (one file, written with the holdout's sealed result). */
export interface HoldoutSummary {
  readonly holdout: SampleSummary;
  /** Share of severe outcomes (blocked, or a net return of −50% or worse). */
  readonly severeRate: number;
  /** One-sided lower bound of the holdout mean at VETO_COMPOSITE_LEVEL (day-block bootstrap). */
  readonly lower: { readonly value: number; readonly level: number };
  readonly candidates: { readonly count: number; readonly hours: number };
  /** Never-entered candidates per `gate:code`, counted as the dry run counts them. */
  readonly rejectMix: Readonly<Record<string, number>>;
  /** Largest net return one trade can make. */
  readonly returnCap: number;
}

export type Line = Record<string, unknown> & { readonly kind: string; readonly ts: string; readonly boot: string };
type Typed = { readonly gate: string; readonly code: string; readonly input?: string };

export interface Veto {
  readonly mint: string;
  readonly atMs: number;
  readonly reasons: readonly Typed[];
}

export interface RunFacts {
  readonly startMs: number;
  readonly endMs: number;
  readonly hours: number;
  readonly qualifying: boolean;
  /** Net returns of the closed kept trades. */
  readonly kept: readonly { readonly mint: string; readonly trade: string; readonly r: number }[];
  /** Mints that entered (open or closed). */
  readonly entered: readonly string[];
  readonly candidates: number;
  readonly rejectMix: Readonly<Record<string, number>>;
  readonly vetoes: readonly Veto[];
  readonly simulations: { readonly attempted: number; readonly succeeded: number; readonly errors: Readonly<Record<string, number>> };
  readonly fillDifferences: readonly number[];
  readonly start: Line;
}

const linesOf = (stateDir: string): Line[] => readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Line);

const typedOf = (l: Line): Typed[] => (Array.isArray(l['gate_reasons']) ? (l['gate_reasons'] as Typed[]) : []);

/**
 * The live-only vetoes and the reject mix of the never-entered candidates, from the decision lines in order. A veto is
 * the candidate's first reject whose typed reasons are all on live-only inputs; a reason without an input is not one.
 */
export const classify = (decisions: readonly Line[], entered: ReadonlySet<string>): { readonly vetoes: Veto[]; readonly rejectMix: Record<string, number> } => {
  const reasonsOf = (l: Line) => (Array.isArray(l['reasons']) ? (l['reasons'] as string[]) : []);
  const lastReject = new Map<string, Line>();
  const vetoes = new Map<string, Veto>();
  for (const l of decisions) {
    if (l['action'] !== 'reject') continue;
    const mint = reasonsOf(l)[2];
    if (mint === undefined || entered.has(mint)) continue;
    lastReject.set(mint, l);
    const typed = typedOf(l);
    if (!vetoes.has(mint) && typed.length > 0 && typed.every((t) => t.input !== undefined && LIVE_ONLY_INPUTS.has(t.input))) {
      vetoes.set(mint, { mint, atMs: Date.parse(l.ts), reasons: typed.map((t) => ({ gate: t.gate, code: t.code, ...(t.input === undefined ? {} : { input: t.input }) })) });
    }
  }
  const rejectMix: Record<string, number> = {};
  for (const l of lastReject.values()) {
    const t = typedOf(l)[0];
    const key = t === undefined ? 'untyped' : `${t.gate}:${t.code}`;
    rejectMix[key] = (rejectMix[key] ?? 0) + 1;
  }
  return { vetoes: [...vetoes.values()], rejectMix };
};

/**
 * Everything G3 needs from the run itself, read without writing, as of `cutMs`: journal lines, trades (closed by
 * then), candidates, vetoes and simulations after it do not count (STATS-1c: the judged data ends at `evaluateAtMs`).
 */
export const readRun = (stateDir: string, cutMs = Number.POSITIVE_INFINITY): RunFacts => {
  const lines = linesOf(stateDir).filter((l) => Date.parse(l.ts) <= cutMs);
  const starts = lines.filter((l) => l.kind === 'start');
  if (starts.length === 0) throw new Error('the journal has no start line');
  const startMs = Date.parse(starts[0]!.ts);
  // Judged up to the evaluation time (the report checks the run reached it), else to the run's last line.
  const endMs = Number.isFinite(cutMs) ? cutMs : Date.parse(lines.at(-1)!.ts);
  const decisions = lines.filter((l) => l.kind === 'decision');
  const reasonsOf = (l: Line) => (Array.isArray(l['reasons']) ? (l['reasons'] as string[]) : []);
  const shortlisted = new Set(decisions.filter((l) => reasonsOf(l)[0] === SHORTLIST).map((l) => reasonsOf(l)[2]!).filter((m) => m !== undefined));
  const entered = new Set(decisions.filter((l) => l['action'] === 'enter').map((l) => reasonsOf(l)[2]!).filter((m) => m !== undefined));
  const { vetoes, rejectMix } = classify(decisions, entered);
  // Kept trades: the account's closed trades, over their entry cost from the ledger.
  const account = parseTyped(readFileSync(join(stateDir, 'account.json'), 'utf8')) as { trades: { positionId: string; mint: string; closedAtMs: number | null; netLamports: bigint | null }[] };
  // A copy: even a read-only SQLite open can leave -shm/-wal files beside the database, and the run's files never change.
  const tmp = mkdtempSync(join(tmpdir(), 'zeroed-g3-ledger-'));
  for (const f of readdirSync(stateDir)) if (f === Ledger.FILE || f === `${Ledger.FILE}-wal`) copyFileSync(join(stateDir, f), join(tmp, f));
  const ledger = openLedgerReader(join(tmp, Ledger.FILE));
  let kept: { mint: string; trade: string; r: number }[];
  try {
    const book = ledger.storedBookEvents({ maxOpenPositions: Number.MAX_SAFE_INTEGER }).book;
    kept = account.trades.filter((t) => t.closedAtMs !== null && t.closedAtMs <= cutMs && t.netLamports !== null).map((t) => {
      const p = book.positions[t.positionId as never];
      const e = p === undefined ? undefined : book.intents[p.entryIntentId];
      const cost = e === undefined ? 0n : e.fills.reduce((s, f) => s + f.sol + f.fees, 0n);
      if (cost <= 0n) throw new Error(`trade ${t.positionId} has no entry cost in the ledger`);
      return { mint: t.mint, trade: t.positionId, r: Number(t.netLamports) / Number(cost) };
    });
  } finally {
    ledger.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  const sims = lines.filter((l) => l.kind === 'simulation');
  const errors: Record<string, number> = {};
  for (const s of sims) if (s['success'] !== true) errors[String(s['outcome'])] = (errors[String(s['outcome'])] ?? 0) + 1;
  // amountErrorE4: |simulated − quoted| / quoted in 0.0001 percentage points; as a fraction of the amount.
  const fillDifferences = sims.filter((s) => s['success'] === true && typeof s['amountErrorE4'] === 'number').map((s) => (s['amountErrorE4'] as number) / 1_000_000);
  return {
    startMs, endMs, hours: (endMs - startMs) / 3_600_000,
    qualifying: starts.every((s) => s['qualifying'] === true) && new Set(starts.map((s) => s['git_sha'])).size === 1,
    kept, entered: [...entered].sort(), candidates: shortlisted.size, rejectMix, vetoes,
    simulations: { attempted: sims.length, succeeded: sims.filter((s) => s['success'] === true).length, errors },
    fillDifferences, start: starts[0]!,
  };
};

/** The run's own strategy and policy, rebuilt as main.ts builds them; refused when they do not match its start line. */
export const runStrategy = (start: Line): { readonly session: PolicySession; readonly strategy: ReturnType<typeof strategyConfig> } => {
  const session = startSession(TRIAL_POLICY);
  if (start['policy_version'] !== session.versionHash) throw new Error(`the run's policy ${String(start['policy_version'])} is not this release's ${session.versionHash}`);
  // The edge the run's strategy used (`edge_ppm`), else the config's paper edge, else none (as main.ts builds it).
  const e = start['edge_ppm'] ?? start['paper_edge_ppm'];
  const edge = typeof e === 'string' || typeof e === 'number' ? BigInt(e) : 0n;
  const entry = start['entry_rule'] === 'S0' ? { timing: 'random' as const, salt: String(start['s0_salt']) } : { timing: 'gates' as const, salt: '' };
  const strategy = strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG, edge, entry);
  if (start['strategy'] !== strategy.version) throw new Error(`the run's strategy ${String(start['strategy'])} is not this release's ${strategy.version}`);
  return { session, strategy };
};

/** The registration as G3 reads it: the plan, and the moment the judged data ends (STATS-1c). */
export type G3RegistrationFile = G3Registration & { readonly evaluateAtMs: number };

/** How far the run's last line may fall short of `evaluateAtMs` and still count as having reached it. */
export const EVALUATE_SLACK_MS = 60_000;

export interface G3ReportOptions {
  readonly stateDir: string;
  readonly holdout: HoldoutSummary;
  readonly registration: G3RegistrationFile;
  /** TEST-1's parity result on this run's recorded data; absent counts as failed. */
  readonly parityPassed: boolean;
  readonly out: string;
  /** The paper world's fill scenario; the run's own (main.ts: the paper scenario) unless a test runs another. */
  readonly scenario?: FillScenario;
}

export interface G3Report {
  readonly result: GateResult;
  readonly counterfactuals: readonly (CounterfactualTrade & { readonly vetoAtMs: number; readonly vetoReasons: readonly Typed[] })[];
}

/** Scores the vetoed candidates offline and runs G3; writes `<out>/counterfactuals.jsonl` and `<out>/g3.json`. */
export const g3Report = async (o: G3ReportOptions): Promise<G3Report> => {
  const cut = o.registration.evaluateAtMs;
  if (!Number.isSafeInteger(cut)) throw new Error('the registration has no evaluateAtMs: the judged data has no end');
  if (!existsSync(o.out)) mkdirSync(o.out, { recursive: true });
  // A run that ended before the evaluation time is not judged: not proven, extend (or finish) the run.
  const lastMs = Date.parse(linesOf(o.stateDir).at(-1)!.ts);
  if (lastMs < cut - EVALUATE_SLACK_MS) {
    const detail = `the run's last line is at ${new Date(lastMs).toISOString()}, before the registered evaluation time ${new Date(cut).toISOString()} (less ${EVALUATE_SLACK_MS / 1000} s)`;
    const result: GateResult = { gate: 'G3', passed: false, status: 'not-proven', reasons: [detail], checks: [{ name: 'evaluation time', passed: false, detail }], metrics: {}, notes: ['inconclusive: extend the dry run'] };
    writeFileSync(join(o.out, 'counterfactuals.jsonl'), '');
    writeFileSync(join(o.out, 'g3.json'), `${typedText({ run: { stateDir: o.stateDir, lastMs, evaluateAtMs: cut }, registration: o.registration, result })}\n`);
    return { result, counterfactuals: [] };
  }
  const run = readRun(o.stateDir, cut);
  const { session, strategy } = runStrategy(run.start);
  // The counterfactuals see the recording up to the evaluation time only: a position open then is censored.
  const boots = readRecording(o.stateDir);
  const frames = boots.flatMap((b) => b.frames).filter((f) => f.receivedAt <= cut);
  const bootEnds = boots.slice(0, -1).map((b) => b.frames.at(-1)!.receivedAt);
  const runId = createHash('sha256').update(`${run.start.boot}:${run.start.ts}`).digest('hex').slice(0, 16);
  const counterfactuals: G3Report['counterfactuals'][number][] = [];
  for (const v of run.vetoes) {
    const t = await scoreCounterfactual({
      mint: v.mint, frames, session, rugs: RUG_CONFIG, strategy, scenario: o.scenario ?? FILL_CONFIG.scenarios[PAPER_SCENARIO], network: FILL_CONFIG.network, seed: `g3:${runId}:${v.mint}`, bootEnds,
    });
    // A scoring that refused an event, held another mint or ran another seed is not this candidate's trade.
    if (t.check.refused > 0 || t.check.otherPositions > 0 || t.check.paperSeed !== `g3:${runId}:${v.mint}`) {
      throw new Error(`counterfactual of ${v.mint} is not valid: ${typedText(t.check)}`);
    }
    counterfactuals.push({ ...t, vetoAtMs: v.atMs, vetoReasons: v.reasons });
  }
  // Only candidates the strategy would have entered without the live-only checks were vetoed by them.
  const vetoed = counterfactuals.filter((c) => c.entered);
  const result = gateG3({
    qualifyingRun: run.qualifying, dryRunHours: run.hours, dryRunReturns: run.kept.map((k) => k.r),
    holdout: o.holdout.holdout, holdoutSevereRate: o.holdout.severeRate, registration: o.registration, dryRunStartMs: run.startMs,
    simulations: run.simulations, holdoutLower: o.holdout.lower,
    candidates: { dryRunCount: run.candidates, dryRunHours: run.hours, backtestCount: o.holdout.candidates.count, backtestHours: o.holdout.candidates.hours },
    rejectMix: { dryRun: run.rejectMix, backtest: o.holdout.rejectMix },
    liveOnlyVetoes: { vetoed: vetoed.length, eligible: run.entered.length + vetoed.length },
    vetoCounterfactuals: { returns: vetoed.filter((c) => c.r !== null).map((c) => c.r!), censored: vetoed.filter((c) => c.censored).length },
    returnCap: o.holdout.returnCap, fillDifferences: run.fillDifferences, parityTestPassed: o.parityPassed,
  });
  writeFileSync(join(o.out, 'counterfactuals.jsonl'), counterfactuals.map((c) => typedText(c)).join('\n') + (counterfactuals.length > 0 ? '\n' : ''));
  writeFileSync(join(o.out, 'g3.json'), `${typedText({
    run: { stateDir: o.stateDir, evaluateAtMs: cut, startMs: run.startMs, endMs: run.endMs, hours: run.hours, qualifying: run.qualifying, candidates: run.candidates, entered: run.entered, kept: run.kept, rejectMix: run.rejectMix, simulations: run.simulations },
    vetoes: { classified: run.vetoes.length, vetoed: vetoed.length, eligible: run.entered.length + vetoed.length, notEnteredWithoutThem: counterfactuals.filter((c) => !c.entered).map((c) => c.mint) },
    holdout: o.holdout, registration: o.registration, parityPassed: o.parityPassed, compositeLevel: VETO_COMPOSITE_LEVEL, result,
  })}\n`);
  return { result, counterfactuals };
};

/** The live-only inputs named above are exactly FACT_KINDS' `live-only-veto` facts (checked by a test). */
export const liveOnlyFactKeys = (): string[] => FACT_KINDS.filter((k) => k.source === 'live-only-veto').map((k) => k.key);
