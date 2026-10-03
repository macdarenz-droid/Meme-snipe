// BT-2 command line. Reads a DATA-1 dataset (schema 1 or 2), checks its sums, and runs the study or a day run.
//
//   node packages/backtest/src/study/cli.ts day   --dataset <dir> --sol-usd <file> [--days d1,d2] [--seeds 5] [--replays 10] [--out <dir>]
//   node packages/backtest/src/study/cli.ts study --dataset <dir> --sol-usd <file> --registry <file> [--run-holdout] [--replays 10] [--out <dir>]
//        [--insiders <file>]
//
// `day` runs the strategies and S0 through the whole engine on the selected days (entries everywhere, no holdout) and
// writes the engine evidence: validity, replays, the leak test, the ledger replay check, counts and the reject mix.
// `study` runs the full protocol (walk-forward, G1, the holdout once when asked, G2, G0). Both write a JSON evidence
// file with the commit and the dataset hash; the report holds no outcome of a sealed holdout.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { replayLedgerFile } from '../../../core/src/ledger/replay/index.ts';
import { loadDay, loadManifest, manifestHash, type ManifestDay, regimeBoundariesOf, verifySums } from '../dataset/dataset.ts';
import { readSeries } from '../dataset/offchain.ts';
import type { DatasetRow } from '../dataset/rows.ts';
import { replayHashes } from '../proofs.ts';
import { STUDY_CONFIG, configId, studyHash } from '../strategy/config.ts';
import { runStudy, studyRunOptions, type StudyRunOptions } from './run.ts';
import { countsOf, rejectMix, scoreRun } from './score.ts';
import { runFullStudy, studyLeak } from './study.ts';

/** 2026-10-02 is a regime boundary (pump program upgrade, UPG-1): that day and later are never decision days. */
export const REGIME_BOUNDARY_DAY = '2026-10-02';

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
const byDay = new Map(manifest.days.map((d) => [d.day, d]));
const rowsOf = (from: string, to: string) => function* (): Generator<DatasetRow> {
  for (const d of manifest.days) if (d.day >= from && d.day <= to) yield* loadDay(dataset, d as ManifestDay);
};
const json = (v: unknown) => `${JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 1)}\n`;
const clock = () => performance.now();
const common = {
  commit, dirty, dataset: { dir: dataset, id: datasetId, schema: manifest.schema, sampleRate, sumsChecked, days: manifest.days.map((d) => ({ day: d.day, complete: d.complete, warmUp: d.warm_up })) },
  policy: TRIAL_POLICY.name, fills: FILL_CONFIG.version, research: RESEARCH_CONFIG.version, studyHash: studyHash(STUDY_CONFIG),
  configIds: Object.fromEntries(STUDY_CONFIG.universes.map((u) => [u.universe, configId(STUDY_CONFIG, u.universe)])),
  scenario: 'conservative',
  notes: [
    'Live-only vetoes (§16.3) are absent in the backtest: H15 simulateTransaction, H16 third-party cross-checks, Jupiter routes and fees, execution health. The bias in mean net is at most the veto share v times the gap between vetoed and kept trades; G3 caps v at 10%, which bounds it at 5 points.',
    'H13 needs the deployer-funded wallets and the dev cluster, which DATA-1 does not record: without a funding source every candidate is rejected (H16 not-covered).',
    'The dataset keeps trades for a hash sample of mints only; a deployer with a mint outside the sample in the look-back is not judged on prior rugs (H14 not covered).',
    `${REGIME_BOUNDARY_DAY} and later are never decision days (program upgrade, regime boundary).`,
  ],
};

if (command === 'day') {
  const only = has('days') ? new Set(flag('days').split(',')) : null;
  const days = manifest.days.filter((d) => only === null || only.has(d.day)).map((d) => d.day).sort();
  if (days.length === 0) throw new Error('no days selected');
  if (days.some((d) => d >= REGIME_BOUNDARY_DAY)) throw new Error(`${REGIME_BOUNDARY_DAY} and later are never decision days`);
  const from = Date.parse(`${days[0]}T00:00:00Z`);
  const last = manifest.coverage.last_block_time === undefined ? Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 86_400_000 : manifest.coverage.last_block_time * 1000;
  const runId = `day-${days[0]}-${days[days.length - 1]}-${commit.slice(0, 8)}`;
  const ledgerPath = join(out, `${runId}.sqlite`);
  const opts: Omit<StudyRunOptions, 'mode'> = {
    rows: rowsOf(days[0]!, days[days.length - 1]!), series: [solUsd], seed: 'bt2-day', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG,
    research: RESEARCH_CONFIG, windowEnd: last, study: STUDY_CONFIG, entriesFrom: from, entriesTo: last - TRIAL_POLICY.exits.tMaxMs - RESEARCH_CONFIG.s0.endMarginMs,
    sampleRate, regimeBoundaries: regimeBoundariesOf(manifest), ...(manifest.coverage_gaps === undefined ? {} : { coverageGaps: manifest.coverage_gaps }),
    ...(insiders === undefined ? {} : { insiders }),
  };
  const t0 = clock();
  const r = runStudy({ ...opts, mode: 'strategy', ledgerPath });
  const runMs = Math.round(clock() - t0);
  const seeds = Number(flag('seeds', '5'));
  const s0 = Array.from({ length: seeds }, (_, k) => runStudy({ ...opts, mode: 's0', seed: `bt2-day:s0:${k}` }));
  const replays = Number(flag('replays', '10'));
  const hashes = [r.logHash, ...replayHashes(studyRunOptions({ ...opts, mode: 'strategy' }), Math.max(0, replays - 1))];
  const leak = studyLeak(studyRunOptions({ ...opts, mode: 'strategy' }), days, 'bt2-day');
  const ledgerReplay = replayLedgerFile(ledgerPath);
  const evidence = {
    kind: 'BT-2 day run', runId, ...common, days, entriesWindow: { from: new Date(opts.entriesFrom).toISOString(), to: new Date(opts.entriesTo).toISOString() },
    engine: {
      stats: r.stats, runMs, rowsPerSecond: Math.round(r.stats.rows / (runMs / 1000)), replays: hashes.length, identicalReplays: new Set(hashes).size === 1,
      leak, ledgerReplay,
    },
    facts: r.facts?.counts ?? null,
    counts: countsOf(r), rejectMix: rejectMix(r.records),
    s0: s0.map((x) => ({ seed: x.seed, stats: { crashes: x.stats.crashes, illegalStates: x.stats.illegalStates, unreconciledIntents: x.stats.unreconciledIntents }, counts: countsOf(x) })),
    // A day run has no holdout; its trades are research output, reported as such.
    trades: scoreRun(r, FILL_CONFIG),
    regimeBoundariesPassed: r.regimes.map((b) => ({ slot: b.slot.toString(), label: b.label, at: new Date(b.at).toISOString() })),
  };
  writeFileSync(join(out, `${runId}.json`), json(evidence));
  console.log(json({ runId, stats: r.stats, identical: evidence.engine.identicalReplays, leak: leak.ok, ledgerReplay: ledgerReplay.ok, counts: evidence.counts, facts: evidence.facts }));
} else if (command === 'study') {
  const decisionDays = manifest.days.filter((d) => d.complete && !d.warm_up && d.day < REGIME_BOUNDARY_DAY).map((d) => d.day).sort();
  const lead = manifest.window as { lead_in_days?: number };
  const leadIn = Number(lead.lead_in_days ?? 14);
  const first = [...byDay.keys()].sort()[0]!;
  // A dataset assembled with its lead-in lists the lead-in days as warm-up days; decision days are the rest.
  const report = runFullStudy({
    config: STUDY_CONFIG, policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, decisionDays, rows: rowsOf, firstDay: first,
    series: [solUsd], sampleRate, ...(manifest.coverage_gaps === undefined ? {} : { coverageGaps: manifest.coverage_gaps }),
    ...(insiders === undefined ? {} : { insiders }), registryPath: flag('registry'), outDir: out, seed: 'bt2', replays: Number(flag('replays', '10')),
    runHoldout: has('run-holdout'), startedAt: new Date().toISOString(), regimeBoundaries: regimeBoundariesOf(manifest),
  });
  const runId = `study-${decisionDays[0]}-${decisionDays[decisionDays.length - 1]}-${commit.slice(0, 8)}`;
  writeFileSync(join(out, `${runId}.json`), json({ kind: 'BT-2 study', runId, ...common, leadInDays: leadIn, ...report }));
  console.log(json({ runId, G0: report.gates.G0.status, G1: Object.fromEntries(Object.entries(report.gates.G1).map(([u, g]) => [u, g.status])), G2: report.gates.G2.status }));
} else {
  throw new Error('usage: cli.ts day|study --dataset <dir> --sol-usd <file> ...');
}
