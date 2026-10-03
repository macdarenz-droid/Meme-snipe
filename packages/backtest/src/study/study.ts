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
import { attemptAlpha, type StudyConfig, configId, studyHash } from '../strategy/config.ts';
import { g0, g1, g2NotProven, gateG2, type G2Short, pboMatrix, powerOf, trialOf } from './gates.ts';
import { foldSummary, purge, regimeOf, studyPlan, type StudyPlan } from './plan.ts';
import { loadOrCreate, readStudyRegistry, recordTrial, register, type StudyRegistry, writeStudyRegistry } from './registry.ts';
import { runStudy, studyRunOptions, type StudyRunOptions } from './run.ts';
import { type FunnelSummary } from './funnel.ts';
import { openSealed, runSealedHoldout, sealedReady } from './sealed.ts';
import { countsOf, rejectMix, scoreRun, type ScoredTrade } from './score.ts';
import { completenessManifest, type ManifestRow, missingEvidence } from './completeness.ts';
import { tradesOf as tradesOfRun } from '../trades.ts';
import type { DeploymentStats, StudyStrategy } from '../strategy/study.ts';

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
  /** Raw records exist for every create and pool creation (DATA-1 #46), not only the hash sample. */
  readonly rawForAll?: boolean;
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
  /** The deployment replay (walk-forward days): real size, one account, R3–R11 and the kill switch on. */
  readonly deployment: {
    readonly stats: RunResult['stats'];
    readonly trades: number;
    readonly netLamports: string;
    /** Value still held when the data ended (blocked or never exited), lamports at the last rung's quote. */
    readonly strandedLamports: string;
    readonly maxDrawdownUsd: string;
    readonly killSwitchTrips: number;
    readonly weeklyTrips: number;
    readonly rejectedOpportunities: Readonly<Record<string, number>>;
    readonly notes: readonly string[];
  };
  /**
   * Blocked candidates' outcomes per ablated gate, universe and regime (paper only). A filter is removed only when
   * out-of-sample evidence shows removing it improves net results without an unacceptable tail (pre-registered: the
   * 5th-percentile trade and the maximum drawdown no worse at the one-sided 95% level); until then it stays on.
   */
  /**
   * The funnel on the practice days, gate by gate, by universe: adverse rejects apart from missing evidence ("not
   * covered"), for the research sample (each candidate on its own) and the deployment replay (one account, its limits).
   */
  readonly funnel: { readonly research: Readonly<Record<string, FunnelSummary>>; readonly deployment: Readonly<Record<string, FunnelSummary>> };
  /** Which gate inputs the dataset and supplements rebuild as of each decision, and how often each was missing. */
  readonly completeness: { readonly manifest: readonly ManifestRow[]; readonly missing: Readonly<Record<string, Readonly<Record<string, number>>>> };
  readonly ablations: readonly {
    readonly gates: readonly string[];
    readonly byUniverse: Readonly<Record<string, Readonly<Record<string, { readonly blocked: number; readonly meanNet: number | null; readonly lossesAvoided: number; readonly profitsExcluded: number; readonly p5: number | null }>>>>;
  }[];
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
  const plan = studyPlan(c, tail);
  // Practice days always; the holdout days (through the observation tail) only when the holdout is run.
  const needed = [...plan.walkForward.days, ...(i.runHoldout ? plan.holdout.days : [])];
  const absent = needed.filter((d) => !i.availableDays.includes(d));
  if (absent.length > 0) throw new RangeError(`the dataset lacks ${absent.length} days the study needs (first ${absent[0]}); the study runs on whole windows only`);
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
  // The strategy object is made when the run starts; its funnel is read after the run.
  let wfStrategy: StudyStrategy | null = null;
  const wf = runStudy({ ...wfOpts, mode: 'strategy', ledgerPath: wfLedger, onStrategy: (x) => { wfStrategy = x; } });
  const research: Record<string, FunnelSummary> = (wfStrategy as StudyStrategy | null)?.funnel.summary() ?? {};
  const s0 = Array.from({ length: c.s0SeedsWalkForward }, (_, k) => runStudy({ ...wfOpts, mode: 's0', seed: `${i.seed}:s0:${k}` }));

  // 1b. Deployment replay on the same days (never on the holdout): the setups at the real size against one account.
  let depStats: DeploymentStats | null = null;
  let depStrategy: StudyStrategy | null = null;
  const dep = runStudy({ ...wfOpts, mode: 'deployment', seed: `${i.seed}:deployment`, onStrategy: (x) => { depStats = x.deployment; depStrategy = x; } });
  const admitted: Record<string, FunnelSummary> = (depStrategy as StudyStrategy | null)?.funnel.summary() ?? {};

  // 1c. Ablations (paper only, walk-forward days): what H9, H11 and H14 block, scored like accepted trades.
  const ABLATIONS: readonly (readonly ('H9' | 'H11' | 'H14')[])[] = [['H9'], ['H11'], ['H14']];
  const ablationRuns = ABLATIONS.map((g) => ({ gates: g, run: runStudy({ ...wfOpts, mode: 'strategy', ablate: g, seed: `${i.seed}:ablate:${g.join('')}` }) }));

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
  const missing = c.frozen ? universes.filter((u) => !reg.holdouts.entries.some((e) => e.holdoutId === holdoutIdOf(u))) : [];
  reg = register(reg, missing.map((u) => ({ holdoutId: holdoutIdOf(u), universe: u, configId: ids[u]!, fromDay: plan.holdout.fromDay, toDay: plan.holdout.toDay })));
  writeStudyRegistry(i.registryPath, reg);

  const matrix = pboMatrix(Object.fromEntries(reg.trials.map((t) => [t.trialId, scored.kept.filter((x) => ids[x.tag] === t.trialId)])), wfDays.map((d) => d));
  // G1 per universe and regime (§6.5: never pooled silently); the pooled figure is reported under its own label.
  const regimes = [...new Set(scored.kept.map((t) => t.regime))].sort();
  const G1: Record<string, GateResult> = {};
  for (const u of universes) {
    const e = reg.holdouts.entries.find((x) => x.holdoutId === holdoutIdOf(u));
    const before = e !== undefined && e.seal !== 'opened' && e.configId === ids[u];
    for (const g of [...regimes, 'pooled']) {
      const pick = <T extends { regime: string }>(xs: readonly T[]) => (g === 'pooled' ? xs : xs.filter((t) => t.regime === g));
      G1[`${u} ${g === 'pooled' ? 'all regimes (pooled)' : `regime ${g}`}`] = g1({ universe: u, configId: ids[u]!, trades: pick(tradesOf(u)), control: pick(controlOf(u)) }, reg.trials, matrix, seedNumber(`${i.seed}:g1:${u}:${g}`), before);
    }
    // Sensitivity, reported and never gating: the same trades with the token-account rent never returned (fills-2 note).
    const noRent = <T extends { rNetNoRent: number }>(xs: readonly T[]) => xs.map((t) => ({ ...t, rNet: t.rNetNoRent }));
    G1[`${u} all regimes (pooled), sensitivity: no rent recovery`] = g1({ universe: u, configId: ids[u]!, trades: noRent(tradesOf(u)), control: noRent(controlOf(u)) }, reg.trials, matrix, seedNumber(`${i.seed}:g1:${u}:norent`), before);
  }

  // 4. The holdout's size requirement from the walk-forward only (σ̂ and the day structure, §14).
  const power = Object.fromEntries(universes.map((u) => [u, powerOf(sameRegime(tradesOf(u)), sameRegime(controlOf(u)), reg.holdouts.familySize, seedNumber(`${i.seed}:power:${u}`), attemptAlpha(c.holdoutAttempt))]));
  const required = Object.fromEntries(universes.map((u) => [u, power[u]!.ok ? power[u]!.required : null]));
  const holdLedger = `${i.outDir}/holdout-${plan.holdout.fromDay}-${plan.holdout.toDay}.db`;
  let sealed: ReturnType<typeof runSealedHoldout> | null = null;
  const alreadyRun = reg.runs.some((r) => r.holdoutIds.some((h) => universes.some((u) => holdoutIdOf(u) === h)));
  if (i.runHoldout && !c.frozen) throw new Error('the configurations are not frozen: the holdout cannot be run');
  if (i.runHoldout && !alreadyRun) {
    const holdEnd = Date.parse(`${plan.holdout.toDay}T00:00:00Z`) + 86_400_000;
    const leadFrom = dayBefore(plan.holdout.fromDay, 14) < i.firstDay ? i.firstDay : dayBefore(plan.holdout.fromDay, 14);
    sealed = runSealedHoldout(i.registryPath, holdLedger, base(leadFrom, plan.holdout.toDay, holdEnd, plan.holdout.entriesFrom, plan.holdout.entriesTo), {
      byUniverse: universes.map((u) => ({ universe: u, holdoutId: holdoutIdOf(u), configId: ids[u]! })),
      required: Object.fromEntries(universes.map((u) => [u, required[u] ?? Number.POSITIVE_INFINITY])),
    }, Array.from({ length: c.s0SeedsHoldout }, (_, k) => `${i.seed}:holdout-s0:${k}`), i.fills, i.startedAt);
    reg = readStudyRegistry(i.registryPath);
  }

  // 5. G2: the scoring stage opens a seal only after that universe's G1 passed (pooled over the practice days, the
  // cross-regime evidence) and then must open it once its counts are met (consensus of the three reviews).
  const entryOf = (u: string) => reg.holdouts.entries.find((x) => x.holdoutId === holdoutIdOf(u));
  const g1Passed = (u: string) => G1[`${u} all regimes (pooled)`]?.passed === true;
  const ready = universes.filter((u) => g1Passed(u) && required[u] !== null && sealedReady(reg, holdoutIdOf(u), required[u]!));
  let G2: GateResult;
  if (ready.length === 0) {
    const shorts: G2Short[] = universes.map((u) => {
      const e = entryOf(u);
      if (e === undefined) return { universe: u, holdoutId: holdoutIdOf(u), entries: 0, entryDays: 0, required: required[u] ?? null, why: 'configurations not frozen: no holdout registered' };
      const why = e.burned ? `holdout burned (${e.burnReason})` : e.seal === 'registered' ? 'holdout not run yet' : !g1Passed(u) ? 'G1 did not pass: the seal stays closed' : power[u]!.ok ? 'sample short' : (power[u] as { why: string }).why;
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
    }, { familyAlpha: attemptAlpha(c.holdoutAttempt) });
    reg = { ...reg, holdouts: r.registry };
    writeStudyRegistry(i.registryPath, reg);
    // Sensitivity on the opened holdout (already scored above, so no further look): the mean with rent never returned.
    const sens = ready.map((u) => {
      const xs = (open.outcomes.strategy[u] ?? []).map((t) => t.rNetNoRent);
      return `${u}: holdout mean with no rent recovery ${xs.length === 0 ? 'n/a' : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4)} (sensitivity, not gating)`;
    });
    G2 = { ...r, notes: [...r.notes, ...sens] };
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
    completeness: {
      manifest: completenessManifest({ funding: i.insiders !== undefined, rugs: false, rawForAll: i.rawForAll ?? false }),
      missing: missingEvidence(rejectMix(wf.records)),
    },
    funnel: { research, deployment: admitted },
    ablations: ablationRuns.map(({ gates, run }) => {
      const blocked = purge(scoreRun(run, i.fills), plan, c.embargoMs, regime).kept;
      const byUniverse: Record<string, Record<string, { blocked: number; meanNet: number | null; lossesAvoided: number; profitsExcluded: number; p5: number | null }>> = {};
      for (const u of universes) {
        const mine = blocked.filter((t) => t.tag === `${u}-no${gates.join('')}`);
        byUniverse[u] = {};
        for (const g of [...new Set(mine.map((t) => t.regime))].sort()) {
          const xs = mine.filter((t) => t.regime === g).map((t) => t.rNet).sort((a, b) => a - b);
          byUniverse[u]![g] = {
            blocked: xs.length, meanNet: xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length,
            lossesAvoided: -xs.filter((x) => x < 0).reduce((a, b) => a + b, 0), profitsExcluded: xs.filter((x) => x > 0).reduce((a, b) => a + b, 0),
            p5: xs.length === 0 ? null : xs[Math.floor(0.05 * (xs.length - 1))]!,
          };
        }
      }
      return { gates, byUniverse };
    }),
    deployment: (() => {
      const ds = depStats as DeploymentStats | null;
      const tr = scoreRun(dep, i.fills);
      return {
        stats: dep.stats, trades: tr.length, netLamports: tr.reduce((a, t) => a + BigInt(t.net), 0n).toString(),
        strandedLamports: tradesOfRun(dep, i.fills).trades.filter((t) => t.exitReason === 'blocked').reduce((a, t) => a + t.exitSol, 0n).toString(),
        maxDrawdownUsd: (ds?.maxDrawdownUsd ?? 0n).toString(), killSwitchTrips: ds?.trips.filter((x) => x.trip === 'kill_switch').length ?? 0,
        weeklyTrips: ds?.trips.filter((x) => x.trip === 'weekly_loss').length ?? 0, rejectedOpportunities: ds?.rejected ?? {},
        notes: ['The regime gate (R16) is not applied: its inputs are not produced in the backtest yet (FACTS-1).', 'Signal priority at one block: U1 before U2, then the deeper pool, then the mint address.'],
      };
    })(),
    holdout: { ran: sealed !== null || alreadyRun, counts: sealed?.counts ?? Object.fromEntries(universes.map((u) => [u, entryOf(u)?.counts ?? null])), sealHash: sealed?.sealHash ?? null, required },
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
