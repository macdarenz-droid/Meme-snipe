// The BT-2 study end to end (docs/ARCHITECTURE.md §13.2, §14, §20 BT-2):
//   1. walk-forward run of the pre-registered configurations, and S0 on the same days;
//   2. scoring stage: purge and embargo, labels, the experiment registry, G1;
//   3. holdouts registered (one configuration per universe) before any holdout run;
//   4. the sealed holdout, run once (recorded first; a second run burns it), size-checked from its counts;
//   5. G2: opened only when every check on the counts passes, else "not proven yet" with the seals closed;
//   6. G0 from the engine proofs and the ledger replay check.
import type { FillConfig, Policy, ResearchConfig } from '../../../core/src/config/index.ts';
import { OFF_CHAIN } from '../../../core/src/engine/index.ts';
import { createRng, type DayReturn, type GateResult, MIN_DAYS } from '../../../core/src/stats/index.ts';
import type { OffchainSeries } from '../dataset/offchain.ts';
import type { DatasetRow } from '../dataset/rows.ts';
import { leakTest, type ProofReport, shiftTest } from '../proofs.ts';
import type { RunResult } from '../run.ts';
import { replayHashes } from '../proofs.ts';
import { type StudyConfig, configId, studyHash } from '../strategy/config.ts';
import { g0, g1, g2NotProven, gateG2, type G2Short, pboMatrix, powerOf, trialOf } from './gates.ts';
import { foldSummary, purge, regimeOf, studyPlan, type StudyPlan, windowDays } from './plan.ts';
import { loadOrCreate, readStudyRegistry, recordTrial, register, type StudyRegistry, writeStudyRegistry } from './registry.ts';
import { runStudy, studyRunOptions, type StudyRunOptions } from './run.ts';
import { openSealed, runSealedHoldout, sealedReady } from './sealed.ts';
import { countsOf, rejectMix, scoreRun, type ScoredTrade } from './score.ts';

export interface StudyInputs {
  readonly config: StudyConfig;
  readonly policy: Policy;
  readonly fills: FillConfig;
  readonly research: ResearchConfig;
  /** Days the dataset holds complete (the study refuses to run unless every window day is among them). */
  readonly availableDays: readonly string[];
  /** Rows from `fromDay` (inclusive, lead-in included by the caller) through `toDay` (inclusive), in chain order. */
  readonly rows: (fromDay: string, toDay: string) => () => Iterator<DatasetRow>;
  /** First day with data (the lead-in's first day). */
  readonly firstDay: string;
  readonly series: readonly OffchainSeries[];
  readonly sampleRate: number | null;
  readonly coverageGaps?: readonly unknown[];
  readonly insiders?: StudyRunOptions['insiders'];
  readonly registryPath: string;
  /** Where the walk-forward and holdout ledgers go (new files). */
  readonly outDir: string;
  readonly seed: string;
  readonly replays: number;
  /** Run the sealed holdout now (once per window, ever). */
  readonly runHoldout: boolean;
  readonly startedAt: string;
  readonly regimeBoundaries?: readonly { readonly slot: bigint; readonly label: string }[];
  /**
   * The ledger replay check (§15 item 2) on a ledger file: `pnpm ledger:replay` in the CLI. Injected because the
   * study code must not reach ledger internals (label isolation guard).
   */
  readonly ledgerReplay: (path: string) => LedgerReplayResult;
}

export interface LedgerReplayResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface StudyReport {
  readonly studyHash: string;
  readonly configIds: Readonly<Record<string, string>>;
  readonly plan: StudyPlan;
  readonly walkForward: {
    readonly stats: RunResult['stats'];
    readonly counts: ReturnType<typeof countsOf>;
    readonly rejectMix: ReturnType<typeof rejectMix>;
    readonly facts: RunResult['facts'] extends infer F ? (F extends { counts: infer C } ? C | null : null) : null;
    readonly purged: number;
    readonly embargoed: number;
    readonly folds: Readonly<Record<string, ReturnType<typeof foldSummary>>>;
    /** Kept trades per universe and regime. */
    readonly byRegime: Readonly<Record<string, Readonly<Record<string, number>>>>;
    readonly trades: readonly ScoredTrade[];
    readonly s0Seeds: number;
    readonly ledgerReplay: LedgerReplayResult;
  };
  readonly holdout: { readonly ran: boolean; readonly counts: Readonly<Record<string, unknown>> | null; readonly sealHash: string | null; readonly required: Readonly<Record<string, number | null>> };
  readonly gates: { readonly G0: GateResult; readonly G1: Readonly<Record<string, GateResult>>; readonly G2: GateResult };
  readonly holdoutRegime: string;
  readonly proofs: { readonly replayHashes: readonly string[]; readonly leak: ProofReport; readonly shift: ProofReport };
  readonly registry: StudyRegistry;
}

const UNIVERSES = (c: StudyConfig) => c.universes.map((u) => u.universe);
const seedNumber = (s: string): number => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
};
const dayBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export const runFullStudy = (i: StudyInputs): StudyReport => {
  const c = i.config;
  const tail = i.policy.exits.tMaxMs + i.research.s0.endMarginMs;
  const decisionDays = windowDays(c);
  const absent = decisionDays.filter((d) => !i.availableDays.includes(d));
  if (absent.length > 0) throw new RangeError(`the dataset lacks ${absent.length} decision days of the window (first ${absent[0]}); the study runs on the whole window only`);
  const plan = studyPlan(c, decisionDays, tail);
  const regime = (ms: number) => regimeOf(c, ms);
  const universes = UNIVERSES(c);
  const ids = Object.fromEntries(universes.map((u) => [u, configId(c, u)]));
  const wfDays = plan.walkForward.days;
  const wfEnd = Date.parse(`${wfDays[wfDays.length - 1]}T00:00:00Z`) + 86_400_000;
  const base = (from: string, to: string, end: number, entriesFrom: number, entriesTo: number): Omit<StudyRunOptions, 'mode'> => ({
    rows: i.rows(from, to), series: i.series, seed: i.seed, scenario: 'conservative', policy: i.policy, fills: i.fills, research: i.research,
    windowEnd: end, study: c, entriesFrom, entriesTo, sampleRate: i.sampleRate,
    ...(i.coverageGaps === undefined ? {} : { coverageGaps: i.coverageGaps }),
    ...(i.insiders === undefined ? {} : { insiders: i.insiders }),
    ...(i.regimeBoundaries === undefined ? {} : { regimeBoundaries: i.regimeBoundaries }),
  });

  // 1. Walk-forward: the lead-in and the walk-forward days; entries only inside them, every trade finished by their end.
  const wfOpts = base(i.firstDay, wfDays[wfDays.length - 1]!, wfEnd, plan.walkForward.entriesFrom, plan.walkForward.entriesTo);
  const wfLedger = `${i.outDir}/walk-forward.db`;
  const wf = runStudy({ ...wfOpts, mode: 'strategy', ledgerPath: wfLedger });
  const s0 = Array.from({ length: c.s0SeedsWalkForward }, (_, k) => runStudy({ ...wfOpts, mode: 's0', seed: `${i.seed}:s0:${k}` }));

  // 2. Scoring stage.
  const scored = purge(scoreRun(wf, i.fills), plan, c.embargoMs, regime);
  const s0Scored = s0.map((r) => purge(scoreRun(r, i.fills), plan, c.embargoMs, regime).kept);
  const tradesOf = (tag: string) => scored.kept.filter((t) => t.tag === tag);
  const controlOf = (tag: string) => s0Scored.flatMap((xs) => xs.filter((t) => t.tag === `S0-${tag}`));
  // n_power sizes a holdout that lies after the last boundary: σ̂ comes from the walk-forward of that same regime.
  const lastRegime = regimeOf(c, Date.parse(`${plan.holdout.fromDay}T00:00:00Z`));
  const sameRegime = <T extends DayReturn & { regime: string }>(xs: readonly T[]): DayReturn[] => xs.filter((t) => t.regime === lastRegime);

  let reg = loadOrCreate(i.registryPath, universes.length);
  for (const u of universes) reg = recordTrial(reg, { ...trialOf(ids[u]!, tradesOf(u)), configId: ids[u]!, evaluatedOn: `walk-forward ${wfDays[0]}..${wfDays[wfDays.length - 1]}` });
  // 3. One configuration per universe registered for the holdout window before any holdout run.
  const holdoutIdOf = (u: string) => `${u}-${plan.holdout.fromDay}-${plan.holdout.toDay}`;
  const missing = universes.filter((u) => !reg.holdouts.entries.some((e) => e.holdoutId === holdoutIdOf(u)));
  reg = register(reg, missing.map((u) => ({ holdoutId: holdoutIdOf(u), universe: u, configId: ids[u]!, fromDay: plan.holdout.fromDay, toDay: plan.holdout.toDay })));
  writeStudyRegistry(i.registryPath, reg);

  const matrix = pboMatrix(Object.fromEntries(reg.trials.map((t) => [t.trialId, scored.kept.filter((x) => ids[x.tag] === t.trialId)])), wfDays.map((d) => d));
  // G1 per universe and regime (§6.5: never pooled silently); the pooled figure is reported under its own label.
  const regimes = [...new Set(scored.kept.map((t) => t.regime))].sort();
  const G1: Record<string, GateResult> = {};
  for (const u of universes) {
    const e = reg.holdouts.entries.find((x) => x.holdoutId === holdoutIdOf(u))!;
    const before = e.seal !== 'opened' && e.configId === ids[u];
    for (const g of [...regimes, 'pooled']) {
      const pick = <T extends { regime: string }>(xs: readonly T[]) => (g === 'pooled' ? xs : xs.filter((t) => t.regime === g));
      G1[`${u} ${g === 'pooled' ? 'all regimes (pooled)' : `regime ${g}`}`] = g1({ universe: u, configId: ids[u]!, trades: pick(tradesOf(u)), control: pick(controlOf(u)) }, reg.trials, matrix, seedNumber(`${i.seed}:g1:${u}:${g}`), before);
    }
  }

  // 4. The holdout's size requirement from the walk-forward only (σ̂ and the day structure, §14).
  const power = Object.fromEntries(universes.map((u) => [u, powerOf(sameRegime(tradesOf(u)), sameRegime(controlOf(u)), reg.holdouts.familySize, seedNumber(`${i.seed}:power:${u}`))]));
  const required = Object.fromEntries(universes.map((u) => [u, power[u]!.ok ? power[u]!.required : null]));
  const holdLedger = `${i.outDir}/holdout-${plan.holdout.fromDay}-${plan.holdout.toDay}.db`;
  let sealed: ReturnType<typeof runSealedHoldout> | null = null;
  const alreadyRun = reg.runs.some((r) => r.holdoutIds.some((h) => universes.some((u) => holdoutIdOf(u) === h)));
  if (i.runHoldout && !alreadyRun) {
    const holdEnd = Date.parse(`${plan.holdout.toDay}T00:00:00Z`) + 86_400_000;
    const leadFrom = dayBefore(plan.holdout.fromDay, 14) < i.firstDay ? i.firstDay : dayBefore(plan.holdout.fromDay, 14);
    sealed = runSealedHoldout(i.registryPath, holdLedger, base(leadFrom, plan.holdout.toDay, holdEnd, plan.holdout.entriesFrom, plan.holdout.entriesTo), {
      byUniverse: universes.map((u) => ({ universe: u, holdoutId: holdoutIdOf(u), configId: ids[u]! })),
      required: Object.fromEntries(universes.map((u) => [u, required[u] ?? Number.POSITIVE_INFINITY])),
    }, Array.from({ length: c.s0SeedsHoldout }, (_, k) => `${i.seed}:holdout-s0:${k}`), i.fills, i.startedAt);
    reg = readStudyRegistry(i.registryPath);
  }

  // 5. G2: the scoring stage opens a seal only when the counts pass for that universe.
  const entryOf = (u: string) => reg.holdouts.entries.find((x) => x.holdoutId === holdoutIdOf(u))!;
  const ready = universes.filter((u) => required[u] !== null && sealedReady(reg, holdoutIdOf(u), required[u]!));
  let G2: GateResult;
  if (ready.length === 0) {
    const shorts: G2Short[] = universes.map((u) => {
      const e = entryOf(u);
      const why = e.burned ? `holdout burned (${e.burnReason})` : e.seal === 'registered' ? 'holdout not run yet' : power[u]!.ok ? 'sample short' : (power[u] as { why: string }).why;
      return { universe: u, holdoutId: e.holdoutId, entries: e.counts?.entries ?? 0, entryDays: e.counts?.entryDays ?? 0, required: required[u] ?? null, why };
    });
    G2 = g2NotProven(shorts);
  } else {
    const open = openSealed(holdLedger);
    const r = gateG2({
      scenario: 'conservative', registry: reg.holdouts, nowMs: Date.parse(i.startedAt), rng: createRng(seedNumber(`${i.seed}:g2`)),
      universes: ready.map((u) => ({
        universe: u, configId: ids[u]!, holdoutId: holdoutIdOf(u), ledgerHash: open.sealHash, trades: open.outcomes.strategy[u] ?? [],
        controlRuns: open.outcomes.s0.map((s) => s[`S0-${u}`] ?? []), walkForward: sameRegime(tradesOf(u)), power: (power[u] as { power: Parameters<typeof gateG2>[0]['universes'][number]['power'] }).power,
      })),
    });
    reg = { ...reg, holdouts: r.registry };
    writeStudyRegistry(i.registryPath, reg);
    G2 = r;
  }

  // 6. G0: replays, the leak test on the walk-forward data, the ledger replay check and the run's validity.
  const hashes = [wf.logHash, ...replayHashes(studyRunOptions({ ...wfOpts, mode: 'strategy' }), Math.max(0, i.replays - 1))];
  const leak = studyLeak(studyRunOptions({ ...wfOpts, mode: 'strategy' }), wfDays, i.seed);
  // +1-slot shift test on the first walk-forward day (in memory), with that day as its own window.
  const firstDayRows: DatasetRow[] = [];
  const fd = i.rows(wfDays[0]!, wfDays[0]!)();
  for (let r = fd.next(); !r.done; r = fd.next()) firstDayRows.push(r.value);
  const shift = shiftTest(studyRunOptions({ ...wfOpts, mode: 'strategy' }), firstDayRows);
  const ledgerReplay = i.ledgerReplay(wfLedger);
  const censored = scored.kept.filter((t) => t.censored).length;
  const G0 = g0({
    survivorshipFree: true, secondSourceCoverage: 0, undecodedMigrationsReported: true, leakTestPassed: leak.ok, shiftTestPassed: shift.ok,
    replayLogHashes: hashes, parityTestPassed: false, labelsScoredSeparately: true, labelCoverageAuditPassed: censored === 0,
  });
  const g0Extra = [
    { name: 'engine validity', passed: wf.stats.crashes === 0 && wf.stats.illegalStates === 0 && wf.stats.unreconciledIntents === 0, detail: `${wf.stats.crashes} crashes, ${wf.stats.illegalStates} illegal states, ${wf.stats.unreconciledIntents} unreconciled intents` },
    { name: 'ledger replay', passed: ledgerReplay.ok, detail: ledgerReplay.ok ? `pnpm ledger:replay passes on the walk-forward ledger: ${ledgerReplay.detail}` : ledgerReplay.detail.slice(0, 300) },
  ];
  const G0full: GateResult = {
    ...G0, checks: [...G0.checks, ...g0Extra], passed: G0.passed && g0Extra.every((x) => x.passed),
    status: G0.passed && g0Extra.every((x) => x.passed) ? 'pass' : 'fail', reasons: [...G0.reasons, ...g0Extra.filter((x) => !x.passed).map((x) => `${x.name}: ${x.detail}`)],
    notes: [...G0.notes, 'Second-source coverage (DATA-1 QA) and the live/backtest parity test (TEST-1) are not measured by BT-2: they count as failing until their evidence exists.'],
  };

  return {
    studyHash: studyHash(c), configIds: ids, plan,
    walkForward: {
      stats: wf.stats, counts: countsOf(wf), rejectMix: rejectMix(wf.records), facts: (wf.facts?.counts ?? null) as never, purged: scored.purged, embargoed: scored.embargoed,
      folds: Object.fromEntries(universes.map((u) => [u, foldSummary(tradesOf(u), plan.walkForward.folds)])), trades: scored.kept, s0Seeds: s0.length, ledgerReplay,
      byRegime: Object.fromEntries(universes.map((u) => [u, Object.fromEntries(regimes.map((g) => [g, tradesOf(u).filter((t) => t.regime === g).length]))])),
    },
    holdout: { ran: sealed !== null || alreadyRun, counts: sealed?.counts ?? Object.fromEntries(universes.map((u) => [u, entryOf(u).counts])), sealHash: sealed?.sealHash ?? null, required },
    gates: { G0: G0full, G1, G2 },
    holdoutRegime: lastRegime,
    proofs: { replayHashes: hashes, leak, shift },
    registry: reg,
  };
};

/**
 * The leak test on study data: a future-only token planted at the middle of the walk-forward (a create, a pool swap
 * and an account fact) must reach no module and change no decision before its moment; the scored labels carry it
 * and are never handed to the run.
 */
export const studyLeak = (o: ReturnType<typeof studyRunOptions>, days: readonly string[], seed: string): ProofReport => {
  // The middle of the blocks the days actually hold (a partly covered day ends where its data ends).
  const from = Date.parse(`${days[0]}T00:00:00Z`);
  const to = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 86_400_000;
  let first: number | null = null;
  let last: number | null = null;
  const scan = o.rows();
  for (let r = scan.next(); !r.done; r = scan.next()) {
    const t = r.value.blockTime * 1000;
    if (r.value.kind !== 'block' || t < from || t >= to) continue;
    first ??= t;
    last = t;
  }
  if (first === null || last === null) return { ok: false, violations: ['no block inside the days'] };
  const mid = first + Math.floor((last - first) / 2);
  let at: DatasetRow | null = null;
  const it = o.rows();
  for (let r = it.next(); !r.done; r = it.next()) {
    if (r.value.kind === 'block' && r.value.blockTime * 1000 >= mid) {
      at = r.value;
      break;
    }
  }
  if (at === null) return { ok: false, violations: ['no block at the middle of the walk-forward'] };
  const token = `FUTURE-ONLY-${seed}-${mid}`;
  const m = { slot: at.slot, txIndex: OFF_CHAIN - 4, ixIndex: 0, receivedAt: at.blockTime * 1000 };
  const created: DatasetRow = {
    kind: 'event', slot: at.slot, blockTime: at.blockTime, txIdx: OFF_CHAIN - 4, evIdx: 0, signature: `plant-${token}`, program: 'pump', event: 'CreateEvent',
    fields: { mint: token, creator: token, user: token, timestamp: String(at.blockTime), token_total_supply: '1000000000000000' },
  };
  return leakTest(o, {
    token, at: m, rows: [created],
    events: [
      { kind: 'market', id: 'plant:event', moment: { ...m, txIndex: OFF_CHAIN - 3 }, key: `life:${token}`, value: { event: 'Planted', fields: { marker: token } } },
      { kind: 'market', id: 'plant:account', moment: { ...m, txIndex: OFF_CHAIN - 3, ixIndex: 1 }, key: `gates/mint:${token}`, value: { owner: token } },
    ],
  }, { labels: [{ note: token }] });
};

export const MIN_G_DAYS = MIN_DAYS;
