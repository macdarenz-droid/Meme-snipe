// Backtest command line. Runs S0 through the real engine on every day of a DATA-1 dataset, checks the proofs and
// writes the report and an evidence file.
//
//   node packages/backtest/src/cli.ts run --dataset <dir> --sol-usd <file> [--scenario conservative] [--seed s0-1]
//        [--replays 10] [--days 2026-09-01,2026-09-02] [--out report.json] [--evidence evidence.json] [--ledger bt.sqlite]
//   node packages/backtest/src/cli.ts holdout --dataset <dir> --sol-usd <file> --ledger <new file> [--days ...]
//
// The holdout command prints only the sealed ledger's hash and the per-universe candidate and entry counts.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { OFF_CHAIN } from '../../core/src/engine/index.ts';
import { SCENARIO_NAMES, type ScenarioName } from '../../core/src/fills/index.ts';
import type { Bps } from '../../core/src/units/index.ts';
import { loadDay, loadManifest, manifestHash, type ManifestDay, regimeBoundariesOf, verifySums } from './dataset/dataset.ts';
import { readSeries } from './dataset/offchain.ts';
import type { DatasetRow } from './dataset/rows.ts';
import { runHoldout } from './holdout.ts';
import { leakTest } from './proofs.ts';
import { buildReport } from './report.ts';
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
verifySums(dataset);
const manifest = loadManifest(dataset);
const only = args.includes('--days') ? new Set(flag('days').split(',')) : null;
const days: ManifestDay[] = manifest.days.filter((d) => only === null || only.has(d.day));
if (days.length === 0) throw new Error('no days selected');
const solUsd = readSeries(flag('sol-usd'));
const scenario = flag('scenario', 'conservative') as ScenarioName;
if (!SCENARIO_NAMES.includes(scenario)) throw new Error(`scenario must be one of ${SCENARIO_NAMES.join(', ')}`);
const seed = flag('seed', 's0-1');
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
  baseSupply: 1_000_000_000_000_000n, ixName: 'buy_exact_quote_in', user: token,
});
const base: RunOptions = { rows, series: [solUsd], seed, scenario, policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, windowEnd: to, regimeBoundaries };

if (command === 'holdout') {
  const sealed = runHoldout({ ...base, ledgerPath: flag('ledger') });
  console.log(JSON.stringify(sealed));
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
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: import.meta.dirname }).trim();
  const identical = new Set(hashes).size === 1;
  const engine = { replays, identicalReplays: identical, crashes: first.stats.crashes, illegalStates: first.stats.illegalStates, unreconciledIntents: first.stats.unreconciledIntents };
  const g0 = [
    { label: 'Replays with identical decision logs', value: `${replays} runs, ${new Set(hashes).size} hash`, limit: 'all identical', pass: identical },
    { label: 'Leak test (planted future marker)', value: leak.ok ? 'passed' : leak.violations.join('; ').slice(0, 300), limit: 'passes', pass: leak.ok },
    { label: 'Crashes', value: String(first.stats.crashes), limit: '0', pass: first.stats.crashes === 0 },
    { label: 'Illegal states', value: String(first.stats.illegalStates), limit: '0', pass: first.stats.illegalStates === 0 },
    { label: 'Unreconciled intents', value: String(first.stats.unreconciledIntents), limit: '0', pass: first.stats.unreconciledIntents === 0 },
  ].map((c) => ({ mode: 'backtest' as const, ...c }));
  const report = buildReport({
    runId: `${manifestHash(dataset).slice(0, 12)}-${scenario}-${seed}`, generatedAt: new Date().toISOString(), codeCommit: commit,
    policy: TRIAL_POLICY, fills: FILL_CONFIG, dataset: { id: `sha256:${manifestHash(dataset)}`, from, to }, engine, solUsd,
    candidates, entries, groups: [{ group: 'S0', trades, stray }],
    gates: [
      { mode: 'backtest', gate: 'G0', state: g0.every((c) => c.pass) ? 'pass' : 'fail', checks: g0 },
      { mode: 'backtest', gate: 'G1', state: 'not-run', checks: [{ mode: 'backtest', label: 'S0 exits', value: 'time stop only (until EXIT-1)', limit: 'research run', pass: true }] },
    ],
  });
  const evidence = {
    commit, dataset: { dir: dataset, manifestSha256: manifestHash(dataset), days: days.map((d) => d.day), complete: days.map((d) => d.complete) },
    fillsVersion: FILL_CONFIG.version, researchVersion: RESEARCH_CONFIG.version, policyName: TRIAL_POLICY.name,
    scenario, seed, hashes, identicalReplays: identical, leak, stats: first.stats,
    throughput: { rows: first.stats.rows, elapsedMs: times, rowsPerSecond: Math.round(first.stats.rows / (first.stats.elapsedMs / 1000)), days: days.length,
      projected30DaysMinutes: Math.round(((first.stats.elapsedMs / days.length) * 30) / 60_000) },
    candidates, entries, trades: trades.length, alerts: first.stats.alerts,
    regimeBoundaries: first.regimes.map((b) => ({ slot: b.slot.toString(), label: b.label, at: new Date(b.at).toISOString() })),
    tradesAcrossRegimeBoundary: trades.filter((t) => first.regimes.some((b) => t.openedAt < b.at && t.closedAt >= b.at)).length,
    attempts: Object.fromEntries(['filled', 'failed', 'dropped', 'expired', 'in_flight'].map((o) => [o, first.attempts.filter((a) => a.outcome === o).length])),
  };
  writeFileSync(flag('out', 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(flag('evidence', 'evidence.json'), `${JSON.stringify(evidence, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 1)}\n`);
  console.log(JSON.stringify({ identical, leak: leak.ok, ...first.stats, trades: trades.length, candidates, entries }));
} else {
  throw new Error('usage: cli.ts run|holdout --dataset <dir> --sol-usd <file> ...');
}
