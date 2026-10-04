// Backtest command line. Runs S0 through the real engine on every day of a DATA-1 dataset, checks the proofs and
// writes the report and an evidence file.
//
//   node packages/backtest/src/cli.ts run --dataset <dir> --sol-usd <file> [--scenario conservative] [--seed s0-1]
//        [--replays 10] [--days 2026-09-01,2026-09-02] [--out report.json] [--evidence evidence.json] [--ledger bt.sqlite]
//        [--delay measured|adverse|stress] [--burst-sweep]
//   node packages/backtest/src/cli.ts holdout-plan --dataset <dir> --sol-usd <file> --plan <plan.json>
//   node packages/backtest/src/cli.ts holdout-register --dataset <dir> --sol-usd <file> --holdout-id <id> --attempt <k>
//        [--universe U2] [--scenario ...] [--seed ...]
//   node packages/backtest/src/cli.ts holdout --dataset <dir> --sol-usd <file> --holdout-id <id>
//        --ledger <new file> [--universe U2] [--days ...] [--scenario ...] [--seed ...]
//
// `run` reads practice days only: never a day at or after the research config's reserved holdout start, nor one inside
// a registered window. holdout-register authorises the research config's window (entries before the cutoff, then the
// tail) and the configuration id (strategy, policy, fill model, research settings, code and dataset) before any run.
// The holdout command refuses anything not authorised and prints only the sealed ledger's hash and the per-universe
// candidate and entry counts. The registry lives on the research config's remote branch (registry-git.ts), with a
// local copy at a fixed path in the code's own repository; the command refuses to run from another repository.
import { runHealth } from './strategy-health.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY, policyHash } from '../../core/src/config/index.ts';
import { OFF_CHAIN } from '../../core/src/engine/index.ts';
import { gateG0 } from '../../core/src/stats/index.ts';
import { DELAY_PROFILE_NAMES, type DelayProfileName, SCENARIO_NAMES, type ScenarioName } from '../../core/src/fills/index.ts';
import type { Bps } from '../../core/src/units/index.ts';
import { loadDay, loadManifest, manifestHash, type ManifestDay, regimeBoundariesOf, verifySums } from './dataset/dataset.ts';
import { readSeries } from './dataset/offchain.ts';
import type { DatasetRow } from './dataset/rows.ts';
import { authoriseHoldout, type HoldoutPlan, readHoldoutStore, researchDays, runAndSealHoldout, setHoldoutPlan } from './holdout.ts';
import { leakTest, shiftTest } from './proofs.ts';
import { economics } from './economics.ts';
import { buildReport } from './report.ts';
import { gitRegistryVcs } from './registry-git.ts';
import { burstSweep, ladderCongestion } from './stress.ts';
import { runBacktest, type RunOptions } from './run.ts';
import { tradesOf } from './trades.ts';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

const dataset = flag('dataset');
const sumsChecked = verifySums(dataset);
const manifest = loadManifest(dataset);
const only = args.includes('--days') ? new Set(flag('days').split(',')) : null;
// The registry belongs to the code's own repository (D1): resolved from this file, never from the working directory,
// and the command refuses to run from another repository. It is synced from its remote branch before any use (D2).
const topOf = (cwd: string): string => execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const registryRoot = topOf(import.meta.dirname);
const here = (() => {
  try {
    return topOf(process.cwd());
  } catch {
    return null;
  }
})();
if (here !== registryRoot) throw new Error(`run this command from the code's repository (${registryRoot}), not ${here ?? process.cwd()}`);
const registryPath = join(registryRoot, RESEARCH_CONFIG.holdout.registryPath);
if (args.includes('--registry')) throw new Error(`the holdout registry path is fixed by the research config (${RESEARCH_CONFIG.holdout.registryPath})`);
const registryVcs = gitRegistryVcs({
  root: registryRoot, relPath: RESEARCH_CONFIG.holdout.registryPath, remote: RESEARCH_CONFIG.holdout.registryRemote,
  branch: RESEARCH_CONFIG.holdout.registryBranch, fileName: 'registry.json', repo: RESEARCH_CONFIG.holdout.registryRepo,
});
// Every command sees the shared registry: research runs need its registered windows (H1), holdout commands its runs.
registryVcs.check();
const selected = manifest.days.filter((d) => only === null || only.has(d.day));
if (selected.length === 0) throw new Error('no days selected');
// Research runs read practice days only (H1): chosen holdout days are refused, and without a choice they are left out.
const allowed = command === 'run' ? new Set(researchDays(selected.map((d) => d.day), RESEARCH_CONFIG, existsSync(registryPath) ? readHoldoutStore(registryPath) : null, only !== null)) : null;
const days: ManifestDay[] = selected.filter((d) => allowed === null || allowed.has(d.day));
const solUsd = readSeries(flag('sol-usd'));
const scenario = flag('scenario', 'conservative') as ScenarioName;
if (!SCENARIO_NAMES.includes(scenario)) throw new Error(`scenario must be one of ${SCENARIO_NAMES.join(', ')}`);
const seed = flag('seed', 's0-1');
const delay = args.includes('--delay') ? flag('delay') as DelayProfileName : undefined;
if (delay !== undefined && !DELAY_PROFILE_NAMES.includes(delay)) throw new Error(`delay must be one of ${DELAY_PROFILE_NAMES.join(', ')}`);
const from = Date.parse(`${days[0]!.day}T00:00:00Z`);
const lastDay = Date.parse(`${days[days.length - 1]!.day}T00:00:00Z`) + 86_400_000;
// A partly covered last day ends where the data ends, so S0 plans nothing it could not finish.
const covered = manifest.coverage.last_block_time === undefined ? lastDay : manifest.coverage.last_block_time * 1000;
const to = Math.min(lastDay, covered);

/** Rows of the selected days, one day in memory at a time. */
function* rows(): Generator<DatasetRow> {
  for (const d of days) yield* loadDay(dataset, d);
}

const regimeBoundaries = regimeBoundariesOf(manifest);
/** A future-only PumpSwap swap carrying the marker, planted as a dataset row so it travels through the reader's stream. */
const plantedSwap = (token: string, slot: bigint, blockTime: number): DatasetRow => ({
  kind: 'amm', slot, blockTime, txIdx: OFF_CHAIN - 4, evIdx: 0, signature: `plant-${token}`, pool: token, baseMint: token,
  quoteMint: 'So11111111111111111111111111111111111111112', side: 'buy', mode: 'exact-quote-in', amount: 1_000_000_000n, baseAmount: 0n, quoteAmount: 0n, userQuote: 0n,
  pre: { baseReserve: 200_000_000_000_000n, quoteVault: 80_000_000_000n, virtualQuoteReserves: 0n },
  fees: { split: { lp: 20 as Bps, protocol: 5 as Bps, creator: 95 as Bps }, buybackFeeBps: 0 as Bps, instruction: 'v1' },
  baseSupply: 1_000_000_000_000_000n, ixName: 'buy_exact_quote_in', user: token, userTokenAccount: token, userTokenOwner: token,
});
const base: RunOptions = { rows, series: [solUsd], seed, scenario, policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, windowEnd: to, regimeBoundaries, ...(delay === undefined ? {} : { delay }) };

const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', cwd: import.meta.dirname });
/**
 * The commit, plus a hash of any uncommitted change and of every untracked file under packages/ (names and contents),
 * so the id always names the code that ran.
 */
const codeId = (): string => {
  const head = git('rev-parse', 'HEAD').trim();
  const top = git('rev-parse', '--show-toplevel').trim();
  const h = createHash('sha256').update(git('diff', 'HEAD'));
  // Paths relative to the repository root (ls-files prints them relative to its working directory).
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'packages'], { encoding: 'utf8', cwd: top }).split('\n').filter((f) => f !== '').sort();
  for (const f of untracked) h.update(`\0${f}\0`).update(readFileSync(join(top, f)));
  const dirty = git('diff', 'HEAD') !== '' || untracked.length > 0;
  return dirty ? `${head}+dirty-${h.digest('hex').slice(0, 16)}` : head;
};

if (command === 'holdout-plan' || command === 'holdout-register' || command === 'holdout') {
  mkdirSync(dirname(registryPath), { recursive: true });
  const authority = { registryPath, codeCommit: codeId(), datasetId: `sha256:${manifestHash(dataset)}`, vcs: registryVcs };
  const universe = flag('universe', 'U2');
  const window = { fromDay: days[0]!.day, toDay: days[days.length - 1]!.day };
  if (command === 'holdout-plan') {
    setHoldoutPlan(authority, JSON.parse(readFileSync(flag('plan'), 'utf8')) as HoldoutPlan, RESEARCH_CONFIG);
    console.log(JSON.stringify({ plan: 'set' }));
  } else if (command === 'holdout-register') {
    const holdoutId = flag('holdout-id');
    const index = Number(flag('attempt'));
    // The size requirement max(300, n_power, closed form) in trades and days, n_power and its seed come from the
    // walk-forward; they are frozen with the registration, before any holdout count exists (STATS-1c).
    const requirement = {
      requiredTrades: Number(flag('required-trades')), requiredDays: Number(flag('required-days')), nPower: Number(flag('n-power')), nPowerSeed: Number(flag('n-power-seed')),
    };
    const st = authoriseHoldout(authority, { attempt: index, holdouts: [{ holdoutId, universe, requirement }] }, base);
    const attempt = st.attempts.find((x) => x.index === index)!;
    // The attempt's own window (attempt k >= 2 has its own), the α G2 spends on it (from the STATS-1c registry) and the
    // frozen requirement.
    console.log(JSON.stringify({ registered: holdoutId, attempt: index, alpha: attempt.alpha, requirement, ...attempt.window }));
  } else {
    const sealed = runAndSealHoldout({ ...base, ledgerPath: flag('ledger') }, { ...authority, byUniverse: { [universe]: flag('holdout-id') }, window });
    console.log(JSON.stringify(sealed));
  }
} else if (command === 'run') {
  const replays = Number(flag('replays', '10'));
  const ledger = args.includes('--ledger') ? flag('ledger') : undefined;
  const first = runBacktest({ ...base, ...(ledger === undefined ? {} : { ledgerPath: ledger }) });
  const hashes = [first.logHash];
  const times = [first.stats.elapsedMs];
  for (let k = 1; k < replays; k++) {
    const r = runBacktest(base);
    hashes.push(r.logHash);
    times.push(r.stats.elapsedMs);
  }
  // Leak test on the real data: a future-only marker planted at the middle of the window.
  const mid = from + Math.floor((to - from) / 2);
  const midRow = (() => {
    for (const r of rows()) if (r.kind === 'block' && r.blockTime * 1000 >= mid) return r;
    return null;
  })();
  const token = `FUTURE-ONLY-${seed}-${mid}`;
  const leak = midRow === null ? { ok: false, violations: ['no block at the middle of the window'] } : leakTest(base, {
    token,
    at: { slot: midRow.slot, txIndex: OFF_CHAIN - 4, ixIndex: 0, receivedAt: midRow.blockTime * 1000 },
    rows: [plantedSwap(token, midRow.slot, midRow.blockTime)],
    events: [
      { kind: 'market', id: 'plant:event', moment: { slot: midRow.slot, txIndex: OFF_CHAIN - 3, ixIndex: 0, receivedAt: midRow.blockTime * 1000 }, key: `life:${token}`, value: { event: 'Planted', fields: { marker: token } } },
      { kind: 'market', id: 'plant:account', moment: { slot: midRow.slot, txIndex: OFF_CHAIN - 3, ixIndex: 1, receivedAt: midRow.blockTime * 1000 }, key: `acct:${token}`, value: { owner: token } },
    ],
  }, { labels: [{ note: token }] });
  const { trades, stray } = tradesOf(first, FILL_CONFIG);
  const candidates = first.records.filter((r) => r.type === 'decision' && r.reasons[0] === 'candidate').length;
  const entries = first.attempts.filter((a) => a.purpose === 'entry' && a.outcome === 'filled').length;
  const commit = codeId();
  const identical = new Set(hashes).size === 1;
  const engine = { replays, identicalReplays: identical, crashes: first.stats.crashes, illegalStates: first.stats.illegalStates, unreconciledIntents: first.stats.unreconciledIntents };
  // +1-slot shift test over the whole window.
  const shift = shiftTest(base, rows);
  // G0 is the canonical gate (stats/gates.ts). This run measures replays, the leak test and the shift test; every other
  // input (survivorship and second-source audits, undecoded migrations, live parity, the label stage) is not measured
  // here, enters the gate as not proven, and reads "not run".
  const measured = new Set(['replays', 'leak test', 'shift test']);
  const g0 = gateG0({
    survivorshipFree: false, secondSourceCoverage: 0, undecodedMigrationsReported: false,
    leakTestPassed: leak.ok, shiftTestPassed: shift.ok, replayLogHashes: hashes,
    parityTestPassed: false, labelsScoredSeparately: false, labelCoverageAuditPassed: false,
  });
  const g0Checks = g0.checks.map((c) => ({
    mode: 'backtest' as const, label: c.name, value: measured.has(c.name) ? c.detail.slice(0, 300) : 'not run', limit: 'passes', pass: c.passed,
  }));
  const g0State = g0.passed ? 'pass' as const : g0.checks.some((c) => measured.has(c.name) && !c.passed) ? 'fail' as const : 'not-run' as const;
  const entryDecisions = Object.values(first.book.intents).filter((i) => i.intent.purpose === 'entry').length;
  const money = economics({ trades, stray, entryDecisions, solUsd, window: { from, to }, policy: TRIAL_POLICY, research: RESEARCH_CONFIG });
  const dollars = (v: bigint | null) => (v === null ? 'no trades' : `US$${(Number(v) / 1e6).toFixed(4)}`);
  const report = buildReport({
    runId: `${manifestHash(dataset).slice(0, 12)}-${scenario}-${seed}`, generatedAt: new Date().toISOString(), codeCommit: commit,
    policy: TRIAL_POLICY, fills: FILL_CONFIG, dataset: { id: `sha256:${manifestHash(dataset)}`, from, to }, engine, solUsd,
    candidates, entries, groups: [{ group: 'S0', trades, stray }],
    gates: [
      { mode: 'backtest', gate: 'G0', state: g0State, checks: g0Checks },
      { mode: 'backtest', gate: 'G1', state: 'not-run', checks: [
        { mode: 'backtest', label: 'S0 exits', value: 'time stop only (until EXIT-1)', limit: 'research run', pass: true },
        { mode: 'backtest', label: 'Mean net per filled trade', value: dollars(money.usd.conditionalMeanPerTradeMicro), limit: 'above zero', pass: (money.usd.conditionalMeanPerTradeMicro ?? 0n) > 0n },
        { mode: 'backtest', label: 'All-in net per entry decision', value: dollars(money.usd.allInPerEntryDecisionMicro), limit: 'above zero', pass: (money.usd.allInPerEntryDecisionMicro ?? 0n) > 0n },
        { mode: 'backtest', label: 'Hosting', value: `${dollars(money.operating.hostingMicro)} over ${money.operating.windowDays.toFixed(2)} days, ${money.operating.hostingShareOfBankrollPerMonthBps / 100}% of the bankroll a month`, limit: 'covered by net', pass: money.operating.netAfterHostingMicro > 0n },
        { mode: 'backtest', label: 'Break-even net per trade', value: dollars(money.operating.breakEvenNetPerTradeMicro), limit: 'below the mean net per trade', pass: money.operating.breakEvenNetPerTradeMicro !== null && (money.usd.conditionalMeanPerTradeMicro ?? 0n) > money.operating.breakEvenNetPerTradeMicro },
        { mode: 'backtest', label: 'Hosting at other bankrolls', value: money.atBankrolls.map((b) => `US$${Number(b.bankrollMicro) / 1e6}: ${b.hostingShareOfBankrollPerMonthBps / 100}%/month, break-even ${b.breakEvenBpsOfMinTrade === null ? 'no trades' : `${b.breakEvenBpsOfMinTrade / 100}% of a US$${Number(b.minNotionalMicro) / 1e6} trade`}`).join('; '), limit: 'projection', pass: true },
        { mode: 'backtest', label: 'Fill model', value: `${FILL_CONFIG.version}, ${scenario}${FILL_CONFIG.provisional ? ', provisional values' : ''}`, limit: 'measured values', pass: !FILL_CONFIG.provisional },
      ] },
    ],
  });
  const evidence = {
    commit, dataset: { dir: dataset, manifestSha256: manifestHash(dataset), days: days.map((d) => d.day), complete: days.map((d) => d.complete) },
    sumsChecked,
    fillsVersion: FILL_CONFIG.version, fillsProvisional: FILL_CONFIG.provisional,
    delayProfile: { name: delay ?? FILL_CONFIG.scenarios[scenario].delay, ...FILL_CONFIG.delays[delay ?? FILL_CONFIG.scenarios[scenario].delay], decisionCommitment: RESEARCH_CONFIG.decisionCommitment }, blackouts: first.blackouts, researchVersion: RESEARCH_CONFIG.version, policyName: TRIAL_POLICY.name,
    scenario, seed, hashes, identicalReplays: identical, leak, shift, g0: { status: g0.status, checks: g0.checks }, stats: first.stats,
    throughput: { rows: first.stats.rows, elapsedMs: times, rowsPerSecond: Math.round(first.stats.rows / (first.stats.elapsedMs / 1000)), days: days.length,
      projected30DaysMinutes: Math.round(((first.stats.elapsedMs / days.length) * 30) / 60_000) },
    candidates, entries, trades: trades.length, alerts: first.stats.alerts, economics: money,
    regimeBoundaries: first.regimes.map((b) => ({ slot: b.slot.toString(), label: b.label, at: new Date(b.at).toISOString() })),
    tradesAcrossRegimeBoundary: trades.filter((t) => first.regimes.some((b) => t.openedAt < b.at && t.closedAt >= b.at)).length,
    attemptsCongested: first.attempts.filter((a) => a.congested).length,
    attemptsForcedDrop: { provider: first.attempts.filter((a) => a.forcedDrop === 'provider').length, burst: first.attempts.filter((a) => a.forcedDrop === 'burst').length },
    // Blocked exits when the whole ladder fell inside congestion (feeds y_severe).
    ladderCongestion: ladderCongestion(first),
    // Strategy health, observation only (STRATEGY-HEALTH-OBS): the same reducer as the worker; nothing reads it.
    health: runHealth(first, { trades, stray }, { lineageId: 'S0', strategyVersionHash: RESEARCH_CONFIG.version, universe: 'U2', policyHash: policyHash(TRIAL_POLICY), executionModelHash: `${FILL_CONFIG.version}:${scenario}` }),
    // Expectancy and survival against burst frequency (opt-in: 12 more runs).
    burstSweep: args.includes('--burst-sweep') ? burstSweep(base, { perDay: [0, 2, 8, 24], durationsMs: [10_000, 30_000, 60_000] }, { from, to }) : 'not run (--burst-sweep)',
    exitRetries: first.attempts.filter((a) => a.exitRetry > 0).length,
    attempts: Object.fromEntries(['filled', 'failed', 'dropped', 'expired', 'in_flight'].map((o) => [o, first.attempts.filter((a) => a.outcome === o).length])),
  };
  writeFileSync(flag('out', 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(flag('evidence', 'evidence.json'), `${JSON.stringify(evidence, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 1)}\n`);
  console.log(JSON.stringify({ identical, leak: leak.ok, shift: shift.ok, g0: g0State, ...first.stats, trades: trades.length, candidates, entries }));
} else {
  throw new Error('usage: cli.ts run|holdout --dataset <dir> --sol-usd <file> ...');
}
