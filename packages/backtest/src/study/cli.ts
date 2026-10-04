// BT-2 command line. Reads a DATA-1 dataset (schema 1 or 2), checks its sums, and runs the study or a day run.
//
//   node packages/backtest/src/study/cli.ts day   --dataset <dir> --sol-usd <file> [--days d1,d2] [--seeds 5] [--replays 10] [--out <dir>]
//   node packages/backtest/src/study/cli.ts trial --dataset <dir> --sol-usd <file> [--seeds 5] [--out <dir>]
//   node packages/backtest/src/study/cli.ts study --dataset <dir> --sol-usd <file> --registry <file> [--run-holdout] [--replays 10] [--out <dir>]
//   (each takes [--insiders <file>], a funding supplement: { mint: { knownAtMs, funded, devCluster } }, and
//   [--pool-accounts <file>], H17's pool record: { pool: { knownAtMs, accountBytes, isCashbackCoin, coinCreator } }, and
//   [--delegates-complete] only for a dataset that keeps every approval-changing transaction on tracked token accounts;
//   [--volume-hours <dir>] DATA-1c's volume-hours-DAY.csv assets for the regime's volume (dataset files are read too);
//   [--regime-assumed-on] a labelled diagnostic while the regime gate's inputs are not produced; refused with --run-holdout)
//
// `day` runs the strategies and S0 through the whole engine on the selected days and writes the engine evidence:
// validity, replays, the leak test, the ledger replay check, counts and the reject mix. On a day of the fixed holdout
// window it runs with entries off and reports engine validity only (no candidates, rejects or trades): a holdout day
// is never run or shown before its one sealed run (§14, §17 trial view).
// `trial` tests the practice days present (window days before the holdout, each with its 14-day look-back) and writes
// a cumulative trial report, labelled as a trial in progress and not a verdict.
// `study` runs the full protocol (walk-forward, G1, the holdout once when asked, G2, G0) on the whole window.
// Every file carries the commit and the dataset hash; no report holds an outcome of a sealed holdout.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitsFor, FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { loadDay, loadManifest, loadVolumeHours, manifestHash, type ManifestDay, regimeBoundariesOf, verifySums } from '../dataset/dataset.ts';
import { parseVolumeHoursCsv, type VolumeHour } from '../../../core/src/facts/index.ts';
import { readSeries } from '../dataset/offchain.ts';
import type { DatasetRow } from '../dataset/rows.ts';
import { replayHashes } from '../proofs.ts';
import { STUDY_CONFIG, configId, studyHash } from '../strategy/config.ts';
import { runStudy, studyRunOptions, type StudyRunOptions } from './run.ts';
import { countsOf, rejectMix, scoreRun, tagOf } from './score.ts';
import { assertPractice, toPartTrade, type TrialPart } from './trial.ts';
import { tradesOf } from '../trades.ts';
import { runFullStudy, studyLeak } from './study.ts';
import { type FunnelSummary } from './funnel.ts';
import { holdoutDaysOf, windowDays } from './plan.ts';


const args = process.argv.slice(2);
const command = args[0];
const has = (name: string) => args.includes(`--${name}`);
const flag = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

const dataset = flag('dataset');
const sumsChecked = verifySums(dataset);
const manifest = loadManifest(dataset);
const datasetId = `sha256:${manifestHash(dataset)}`;
const sampling = manifest['sampling'] as { launch_rate?: unknown } | undefined;
const sampleRate = typeof sampling?.launch_rate === 'number' ? sampling.launch_rate : null;
const solUsd = readSeries(flag('sol-usd'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: import.meta.dirname }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', cwd: import.meta.dirname }).trim() !== '';
const out = flag('out', join(import.meta.dirname, '../../../../docs/evidence/bt2'));
mkdirSync(out, { recursive: true });
const insiders = has('insiders')
  ? (() => {
    const m = JSON.parse(readFileSync(flag('insiders'), 'utf8')) as Record<string, { knownAtMs: number; funded: string[]; devCluster: string[] }>;
    return (mint: string) => m[mint] ?? null;
  })()
  : undefined;
// Regime volume hours (DATA-1c): the dataset's `volume_hours` files, plus `--volume-hours <dir>` of release assets
// `volume-hours-YYYY-MM-DD.csv`; both through core's parser. A malformed day is refused whole (unknown, never zero).
const volumeHours: VolumeHour[] = [
  ...manifest.days.flatMap((d) => loadVolumeHours(dataset, d)),
  ...(has('volume-hours') ? readdirSync(flag('volume-hours')).filter((f) => /^volume-hours-\d{4}-\d{2}-\d{2}\.csv$/.test(f)).flatMap((f) => {
    const day = f.slice('volume-hours-'.length, -'.csv'.length);
    return parseVolumeHoursCsv(readFileSync(join(flag('volume-hours'), f), 'utf8'), Date.parse(`${day}T00:00:00Z`) / 86_400_000) ?? [];
  }) : []),
];
// H17's pool-account record (DATA-1, ARCHITECTURE §16): { pool: { knownAtMs, accountBytes, isCashbackCoin, coinCreator } }.
const poolAccounts = has('pool-accounts')
  ? (() => {
    const m = JSON.parse(readFileSync(flag('pool-accounts'), 'utf8')) as Record<string, { knownAtMs: number; accountBytes: number; isCashbackCoin: boolean; coinCreator: string }>;
    return (pool: string) => m[pool] ?? null;
  })()
  : undefined;
const byDay = new Map(manifest.days.map((d) => [d.day, d]));
const rowsOf = (from: string, to: string) => function* (): Generator<DatasetRow> {
  for (const d of manifest.days) if (d.day >= from && d.day <= to) yield* loadDay(dataset, d as ManifestDay);
};
/** The named check of §15 item 2, as the owner runs it: `pnpm ledger:replay <file>` (exit 0 = every sequence replays). */
const ledgerReplay = (path: string): { ok: boolean; detail: string } => {
  const root = join(import.meta.dirname, '../../../..');
  try {
    const outText = execFileSync('pnpm', ['--silent', 'ledger:replay', path], { cwd: root, encoding: 'utf8' });
    return { ok: true, detail: outText.trim().slice(0, 500) };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, detail: `${x.stdout ?? ''}${x.stderr ?? ''}${x.message}`.trim().slice(0, 500) };
  }
};
const json = (v: unknown) => `${JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 1)}\n`;
const clock = () => performance.now();
const common = {
  commit, dirty, regimeGate: has('regime-assumed-on') ? 'assumed on (diagnostic)' : 'evaluated', dataset: { dir: dataset, id: datasetId, schema: manifest.schema, sampleRate, sumsChecked, days: manifest.days.map((d) => ({ day: d.day, complete: d.complete, warmUp: d.warm_up })) },
  policy: TRIAL_POLICY.name, fills: FILL_CONFIG.version, research: RESEARCH_CONFIG.version, studyHash: studyHash(STUDY_CONFIG),
  configIds: Object.fromEntries(STUDY_CONFIG.universes.map((u) => [u.universe, configId(STUDY_CONFIG, u.universe)])),
  scenario: 'conservative',
  notes: [
    'Live-only vetoes (§16.3) are absent in the backtest: H15 simulateTransaction, H16 third-party cross-checks, Jupiter routes and fees, execution health. The bias in mean net is at most the veto share v times the gap between vetoed and kept trades; G3 caps v at 10%, which bounds it at 5 points.',
    'H13 needs the deployer-funded wallets and the dev cluster, which DATA-1 does not record: without a funding source every candidate is rejected (H16 not-covered).',
    'The dataset keeps trades for a hash sample of mints only; a deployer with a mint outside the sample in the look-back is not judged on prior rugs (H14 not covered).',
    `Practice days end at ${STUDY_CONFIG.holdout.fromDay}; holdout days run to the entry cutoff ${STUDY_CONFIG.holdout.entryCutoff} plus ${STUDY_CONFIG.holdout.tailDays} observation day(s) and are never practice days.`,
  ],
};

const holdout = new Set(holdoutDaysOf(STUDY_CONFIG));
// An assembled window's lead-in days carry no trade rows: trades (and rug coverage) start at the window's first day.
const windowLeadIn = Number((manifest.window as { lead_in_days?: number }).lead_in_days ?? 0);
const tradesFromMs = windowLeadIn > 0 ? Date.parse(`${manifest.window.from}T00:00:00Z`) : undefined;
const complete = manifest.days.filter((d) => d.complete).map((d) => d.day).sort();
const dayMs = 86_400_000;
const day0 = (d: string) => Date.parse(`${d}T00:00:00Z`);

if (command === 'day' || command === 'trial') {
  let days: string[];
  if (command === 'day') {
    const only = has('days') ? new Set(flag('days').split(',')) : null;
    days = manifest.days.filter((d) => only === null || only.has(d.day)).map((d) => d.day).sort();
  } else {
    // Practice days: window days before the holdout, present and complete, each with its 14-day look-back present.
    const practice = windowDays(STUDY_CONFIG).filter((d) => !holdout.has(d));
    // The 14-day look-back is there when its days are in the dataset, or when the dataset was assembled with a lead-in
    // of at least 14 days before the window (DATA-1 windows: lead-in days hold events, stats and blocks).
    const leadIn = Number((manifest.window as { lead_in_days?: number }).lead_in_days ?? 0);
    const lookBack = (d: string) => (leadIn >= STUDY_CONFIG.window.leadInDays && d >= manifest.window.from)
      || Array.from({ length: STUDY_CONFIG.window.leadInDays }, (_, k) => new Date(day0(d) - (k + 1) * dayMs).toISOString().slice(0, 10)).every((x) => byDay.has(x));
    days = practice.filter((d) => complete.includes(d) && lookBack(d));
    // One contiguous run: the longest run of consecutive practice days present.
    const runs: string[][] = [];
    for (const d of days) {
      const last = runs.at(-1);
      if (last !== undefined && day0(d) - day0(last.at(-1)!) === dayMs) last.push(d);
      else runs.push([d]);
    }
    days = runs.sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? 1 : -1))[0] ?? [];
  }
  if (days.length === 0) throw new Error('no days selected');
  const known = new Set([...windowDays(STUDY_CONFIG), ...holdout]);
  if (days.some((d) => !known.has(d))) throw new Error(`${days.find((d) => !known.has(d))} is neither a practice day nor a holdout day`);
  const validityOnly = days.some((d) => holdout.has(d));
  if (command === 'trial' && validityOnly) throw new Error('a trial never runs holdout days');
  const from = day0(days[0]!);
  const lastDay = day0(days[days.length - 1]!) + dayMs;
  const last = Math.min(lastDay, manifest.coverage.last_block_time === undefined ? lastDay : manifest.coverage.last_block_time * 1000);
  const firstRow = [...byDay.keys()].sort().filter((d) => d <= days[0]!).filter((d) => day0(d) >= from - STUDY_CONFIG.window.leadInDays * dayMs)[0]!;
  const runId = `${command}-${days[0]}-${days[days.length - 1]}-${commit.slice(0, 8)}`;
  const ledgerPath = join(out, `${runId}.db`);
  const opts: Omit<StudyRunOptions, 'mode'> = {
    rows: rowsOf(firstRow, days[days.length - 1]!), series: [solUsd], seed: 'bt2-day', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG,
    research: RESEARCH_CONFIG, windowEnd: last, study: STUDY_CONFIG, entriesFrom: from,
    // Entries off on a holdout day: the run proves the engine on real data without trading the holdout.
    entriesTo: validityOnly ? from : last - Math.max(...STUDY_CONFIG.universes.map((u) => exitsFor(TRIAL_POLICY.exits, u.universe).tMaxMs)) - RESEARCH_CONFIG.s0.endMarginMs,
    sampleRate, regimeBoundaries: regimeBoundariesOf(manifest), ...(manifest.coverage_gaps === undefined ? {} : { coverageGaps: manifest.coverage_gaps }),
    ...(insiders === undefined ? {} : { insiders }), ...(poolAccounts === undefined ? {} : { poolAccounts }), delegatesComplete: has('delegates-complete'), volumeHours, ...(has('regime-assumed-on') ? { regime: 'assume-on' as const } : {}), ...(tradesFromMs === undefined ? {} : { tradesFromMs }),
  };
  const t0 = clock();
  // The strategy object is made when the run starts; its funnel is read after the run.
  let strategy: { funnel: { summary(): Record<string, FunnelSummary> } } | null = null;
  const r = runStudy({ ...opts, mode: 'strategy', ledgerPath, onStrategy: (x) => { strategy = x; } });
  const funnel = (strategy as { funnel: { summary(): Record<string, FunnelSummary> } } | null)?.funnel.summary() ?? {};
  const runMs = Math.round(clock() - t0);
  const seeds = Number(flag('seeds', '5'));
  const s0 = Array.from({ length: seeds }, (_, k) => runStudy({ ...opts, mode: 's0', seed: `bt2-day:s0:${k}` }));
  const replays = Number(flag('replays', '10'));
  const hashes = [r.logHash, ...replayHashes(studyRunOptions({ ...opts, mode: 'strategy' }), Math.max(0, replays - 1))];
  const leak = studyLeak(studyRunOptions({ ...opts, mode: 'strategy' }), days, 'bt2-day');
  const replayCheck = ledgerReplay(ledgerPath);
  const engine = {
    stats: r.stats, runMs, rowsPerSecond: Math.round(r.stats.rows / (runMs / 1000)), replays: hashes.length, identicalReplays: new Set(hashes).size === 1,
    leak, ledgerReplay: replayCheck,
  };
  const evidence = validityOnly
    ? {
      kind: 'BT-2 day run, holdout day: engine validity only', runId, ...common, days, entries: 'off (holdout window)', engine,
      facts: r.facts?.counts ?? null,
      s0: s0.map((x) => ({ seed: x.seed, crashes: x.stats.crashes, illegalStates: x.stats.illegalStates, unreconciledIntents: x.stats.unreconciledIntents })),
    }
    : {
      kind: command === 'trial' ? 'BT-2 trial (in progress, not a verdict)' : 'BT-2 day run', runId, ...common, days,
      entriesWindow: { from: new Date(opts.entriesFrom).toISOString(), to: new Date(opts.entriesTo).toISOString() }, engine,
      facts: r.facts?.counts ?? null, counts: countsOf(r), funnel, rejectMix: rejectMix(r.records),
      s0: s0.map((x) => ({ seed: x.seed, stats: { crashes: x.stats.crashes, illegalStates: x.stats.illegalStates, unreconciledIntents: x.stats.unreconciledIntents }, counts: countsOf(x), trades: scoreRun(x, FILL_CONFIG) })),
      // Practice-day trades are research output, never proof.
      trades: scoreRun(r, FILL_CONFIG),
      regimeBoundariesPassed: r.regimes.map((b) => ({ slot: b.slot.toString(), label: b.label, at: new Date(b.at).toISOString() })),
    };
  writeFileSync(join(out, `${runId}.json`), json(evidence));
  if (command === 'trial') {
    // The trial part the cumulative report is merged from (trial.ts): practice days only, checked again on merge.
    const tagged = (x: typeof r, tags: readonly string[]) => tradesOf(x, FILL_CONFIG).trades.map((t) => toPartTrade(t, tagOf(t.id))).filter((t) => tags.includes(t.tag));
    const part: TrialPart = {
      kind: 'BT-2 trial part', runId, commit, datasetId, days, regimeAssumedOn: has('regime-assumed-on'),
      engine: { replays: hashes.length, identicalReplays: engine.identicalReplays, crashes: r.stats.crashes, illegalStates: r.stats.illegalStates, unreconciledIntents: r.stats.unreconciledIntents, leak: leak.ok, ledgerReplay: replayCheck.ok },
      candidates: Object.values(countsOf(r)).reduce((t, c) => t + c.candidates, 0), entries: Object.values(countsOf(r)).reduce((t, c) => t + c.entries, 0),
      trades: [...tagged(r, ['U1', 'U2']), ...(s0[0] === undefined ? [] : tagged(s0[0], ['S0-U1', 'S0-U2']))],
    };
    assertPractice(STUDY_CONFIG, part.days, part.trades);
    writeFileSync(join(out, `trial-part-${days[0]}-${days[days.length - 1]}.json`), json(part));
  }
  console.log(json({ runId, validityOnly, stats: r.stats, identical: engine.identicalReplays, leak: leak.ok, ledgerReplay: replayCheck.ok, facts: r.facts?.counts ?? null }));
} else if (command === 'study') {
  const first = [...byDay.keys()].sort()[0]!;
  const report = runFullStudy({
    config: STUDY_CONFIG, policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, availableDays: complete, rows: rowsOf, firstDay: first,
    series: [solUsd], sampleRate, ...(manifest.coverage_gaps === undefined ? {} : { coverageGaps: manifest.coverage_gaps }),
    ...(insiders === undefined ? {} : { insiders }), ...(poolAccounts === undefined ? {} : { poolAccounts }), delegatesComplete: has('delegates-complete'), volumeHours, ...(has('regime-assumed-on') ? { regimeGate: 'assume-on' as const } : {}), registryPath: flag('registry'), outDir: out, seed: 'bt2', replays: Number(flag('replays', '10')),
    runHoldout: has('run-holdout'), startedAt: new Date().toISOString(), regimeBoundaries: regimeBoundariesOf(manifest), ledgerReplay,
  });
  const days = windowDays(STUDY_CONFIG);
  const runId = `study-${days[0]}-${days[days.length - 1]}-${commit.slice(0, 8)}`;
  writeFileSync(join(out, `${runId}.json`), json({ kind: 'BT-2 study', runId, ...common, ...report }));
  console.log(json({ runId, G0: report.gates.G0.status, G1: Object.fromEntries(Object.entries(report.gates.G1).map(([u, g]) => [u, g.status])), G2: report.gates.G2.status }));
} else {
  throw new Error('usage: cli.ts day|trial|study --dataset <dir> --sol-usd <file> ...');
}
