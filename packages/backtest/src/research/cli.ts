// RES-3 signal research on practice days (docs/research/signals.md).
//   node packages/backtest/src/research/cli.ts --dataset <dir> --sol-usd <file> [--window <file>] [--registry <STATS-1 registry json>]
//        [--out research/signals] [--seed res3-1] [--replicates 2000]
// The wall comes from the committed research/signals/window.json; --window may only move it earlier. A confirmed window
// needs the STATS-1 registry. Holdout and embargo days are dropped before any file is opened; a row past the wall stops
// the run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import type { ScenarioName } from '../../../core/src/fills/index.ts';
import { loadDay, loadManifest, manifestHash, verifySums } from '../dataset/dataset.ts';
import { readSeries } from '../dataset/offchain.ts';
import type { DatasetRow } from '../dataset/rows.ts';
import type { HoldoutRegistry } from '../../../core/src/stats/index.ts';
import { evaluate, handoffs, type Obs, type Registry, univariate, withRegistry } from './analysis.ts';
import { type Candidate, collectCandidates, PLAN_DRIVE, solUsdAsOf, type Universe } from './candidates.ts';
import { appliesTo, type Outcome, PLAN_BARRIERS, scoreCandidates } from './outcome.ts';
import { assertReadable, latestRegime, loadWindow, readableDays, resolveWindow, wallDay } from './practice.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

const dataset = flag('dataset');
const committed = loadWindow(join(import.meta.dirname, '..', '..', '..', '..', 'research', 'signals', 'window.json'));
const registry = args.includes('--registry') ? (JSON.parse(readFileSync(flag('registry'), 'utf8')) as HoldoutRegistry) : null;
const window = resolveWindow(committed, args.includes('--window') ? loadWindow(flag('window')) : committed, registry);
const out = flag('out', 'research/signals');
const seed = flag('seed', 'res3-1');
const replicates = Number(flag('replicates', '2000'));
verifySums(dataset);
const manifest = loadManifest(dataset);
const days = readableDays(window, manifest.days);
for (const d of days) assertReadable(window, d.day);
const series = readSeries(flag('sol-usd'));
const solUsd = solUsdAsOf(series, 2 * 3_600_000);

function* rows(): Generator<DatasetRow> {
  for (const d of days) yield* loadDay(dataset, d);
}

const drive = collectCandidates(rows(), { window, policy: TRIAL_POLICY, solUsd, ...PLAN_DRIVE });
const eligible = drive.candidates.filter((c) => c.eligible);
const score = (scenario: ScenarioName): Map<string, Outcome> =>
  new Map(scoreCandidates(rows(), eligible.map(({ id, pool, decisionSlot, decisionMs, solUsd: px }) => ({ id, pool, decisionSlot, decisionMs, solUsd: px })), { window, policy: TRIAL_POLICY, fills: FILL_CONFIG, scenario, barriers: PLAN_BARRIERS, seed, entryMinOutBelowBps: RESEARCH_CONFIG.s0.entryMinOutBelowBps }).map((o) => [o.id, o]));
const outcomes = { conservative: score('conservative'), base: score('base') };

const obsOf = (u: Universe, barrier: number, scenario: 'conservative' | 'base'): Obs[] =>
  eligible.filter((c) => c.universe === u).flatMap((c: Candidate): Obs[] => {
    const o = outcomes[scenario].get(c.id);
    const l = o?.labels[barrier];
    if (o === undefined || o.noQuote || l === undefined || l.censored || l.rNet === null) return [];
    return [{ id: c.id, day: c.day, decisionMs: c.decisionMs, features: c.features, rNet: l.rNet, severe: l.ySevere === 1, blocked: l.blocked, regime: c.regime }];
  });

const reg: Registry = { rows: [] };
const ev = { k: 5, embargoDays: window.embargoDays, seed: 1, replicates, latestRegime: latestRegime(window) };
const verdicts = [];
const context = [];
for (const u of ['U1', 'U2'] as const) {
  for (let b = 0; b < PLAN_BARRIERS.length; b++) {
    if (!appliesTo(PLAN_BARRIERS[b]!, u)) continue;
    const obs = obsOf(u, b, 'conservative');
    const tag = { universe: u, barrier: PLAN_BARRIERS[b]!.cfgId };
    const n = new Set(obs.map((x) => x.day)).size;
    if (n < 5) {
      verdicts.push({ ...tag, skipped: `only ${n} practice days with labelled candidates` });
      continue;
    }
    verdicts.push(evaluate(obs, tag, reg, ev));
    const baseObs = obsOf(u, b, 'base');
    context.push({ ...tag, scenario: 'base', n: baseObs.length, mean: baseObs.length > 0 ? baseObs.reduce((a, x) => a + x.rNet, 0) / baseObs.length : null });
  }
}
// The univariate view is logged as trials before the DSR is computed against the full registry.
const views = (['U1', 'U2'] as const).map((u) => ({ universe: u, features: univariate(obsOf(u, 0, 'conservative'), { seed: 2, replicates }, reg, { universe: u, barrier: PLAN_BARRIERS[0]!.cfgId }) }));
const final = verdicts.map((v) => ('skipped' in v ? v : withRegistry(v, reg)));
const handoff = handoffs(final, PLAN_BARRIERS.map((b) => b.cfgId));

mkdirSync(out, { recursive: true });
const counts = Object.fromEntries((['U1', 'U2'] as const).map((u) => [u, {
  decisions: drive.candidates.filter((c) => c.universe === u).length,
  eligible: eligible.filter((c) => c.universe === u).length,
  rejects: drive.candidates.filter((c) => c.universe === u).flatMap((c) => c.rejects).reduce<Record<string, number>>((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {}),
}]));
const result = {
  task: 'RES-3', dataset: `sha256:${manifestHash(dataset)}`, wall: wallDay(window), window, days: days.map((d) => d.day), seed,
  purged: drive.purged, unquotableSwaps: drive.unquotableSwaps, counts, trials: reg.rows.length, handoff, verdicts: final, baseScenario: context, univariate: views,
};
writeFileSync(join(out, 'results.json'), JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
writeFileSync(join(out, 'handoff.json'), JSON.stringify(handoff, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
writeFileSync(join(out, 'trials.jsonl'), reg.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify({ wall: result.wall, days: days.length, counts, trials: reg.rows.length, handoff: handoff.map((h) => `${h.universe}: ${h.status}${h.barrier === null ? '' : ` (${h.barrier}, ${h.rule})`}`), pass: final.map((v) => ('skipped' in v ? `${v.universe}/${v.barrier}: skipped` : `${v.universe}/${v.barrier}: ${v.pass ? 'PASS' : 'no reliable signal'} (${v.finalRule})`)) }, null, 2));
