// RES-5 survival study on practice days (docs/research/survival.md). Exploration, not proof.
//   node packages/backtest/src/research/survival-cli.ts --dataset <dir> --sol-usd <file> [--window <file>] [--registry <file>]
//        [--out research/survival] [--seed res5-1] [--replicates 2000]
// The wall is RES-3's committed one (research/signals/window.json); --window may only move it earlier.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { loadDay, loadManifest, manifestHash, verifySums } from '../dataset/dataset.ts';
import { readSeries } from '../dataset/offchain.ts';
import type { DatasetRow } from '../dataset/rows.ts';
import { solUsdAsOf } from './candidates.ts';
import { PLAN_BARRIERS, scoreCandidates } from './outcome.ts';
import { assertReadable, loadWindow, readableDays, resolveWindow, type StudyRegistry, wallDay } from './practice.ts';
import { collectSurvival, type SurvivalDecision } from './survival.ts';
import { featureTests, type LabelledDecision, splitDays } from './survival-analysis.ts';
import { compareRules, type FeatureCond, passesFeatures, passesSurvival, survivalRule } from './survival-compare.ts';
import { labelDecisions } from './survival-outcome.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

const dataset = flag('dataset');
const committed = loadWindow(join(ROOT, 'research', 'signals', 'window.json'));
const registryPath = args.includes('--registry') ? flag('registry') : join(ROOT, 'docs', 'evidence', 'bt2', 'registry.json');
const registry = existsSync(registryPath) ? (JSON.parse(readFileSync(registryPath, 'utf8')) as StudyRegistry) : null;
const window = resolveWindow(committed, args.includes('--window') ? loadWindow(flag('window')) : committed, registry);
const out = flag('out', join(ROOT, 'research', 'survival'));
const seed = flag('seed', 'res5-1');
const replicates = Number(flag('replicates', '2000'));
verifySums(dataset);
const manifest = loadManifest(dataset);
const days = readableDays(window, manifest.days);
for (const d of days) assertReadable(window, d.day);
const solUsd = solUsdAsOf(readSeries(flag('sol-usd')), 2 * 3_600_000);
function* rows(): Generator<DatasetRow> {
  for (const d of days) yield* loadDay(dataset, d);
}

// Feature stage, then the outcome stage on a second pass (labels never reach the feature stage).
const drive = collectSurvival(rows(), { window, policy: TRIAL_POLICY, solUsd });
const labels = new Map(labelDecisions(rows(), drive.decisions.map(({ id, pool, labelAtMs }) => ({ id, pool, labelAtMs })), window).map((x) => [x.id, x.label]));
const labelled: (LabelledDecision & { readonly d: SurvivalDecision })[] = drive.decisions.flatMap((d) => {
  const l = labels.get(d.id);
  return l === null || l === undefined ? [] : [{ id: d.id, day: d.day, ageMs: d.ageMs, stratum: d.stratum, features: d.features, survived: l.survived, d }];
});
const tests = featureTests(labelled, replicates, 11);

// Comparison on the check-days, at the decision points, eligible decisions only.
const { check } = splitDays(labelled.map((x) => x.day));
const C = new Set(check);
const eligible = drive.decisions.filter((d) => d.eligibleAs !== null && C.has(d.day));
const scored = new Map(scoreCandidates(rows(), eligible.map(({ id, pool, decisionSlot, decisionMs, solUsd: px }) => ({ id, pool, decisionSlot, decisionMs, solUsd: px })), {
  window, policy: TRIAL_POLICY, fills: FILL_CONFIG, scenario: 'conservative', barriers: PLAN_BARRIERS.slice(0, 2), seed, entryMinOutBelowBps: RESEARCH_CONFIG.s0.entryMinOutBelowBps,
  rentRefundPpm: (FILL_CONFIG.scenarios.conservative.closeSuccessPpm * (1_000_000n - FILL_CONFIG.scenarios.conservative.dustPpm)) / 1_000_000n,
}).map((o) => [o.id, o]));
const pre = JSON.parse(readFileSync(join(ROOT, 'research', 'edge', 'preregistration.json'), 'utf8')) as { hypotheses: { id: string; universe: 'U1' | 'U2'; rules: { kind: string; conds?: FeatureCond[] } }[] };
const rule = survivalRule(tests);
const tradesOf = (pick: (d: SurvivalDecision) => boolean, barrier: number) => eligible.filter(pick).flatMap((d) => {
  const o = scored.get(d.id);
  const l = o?.labels[barrier];
  return o === undefined || o.noQuote || l === undefined || l.rNet === null ? [] : [{ day: d.day, rNet: l.rNet }];
});
const comparison = PLAN_BARRIERS.slice(0, 2).map((b, i) => {
  const s0 = tradesOf(() => true, i);
  const rules = [
    { rule: 'S0 (every eligible decision)', trades: s0 },
    { rule: `survival rule: ${rule.length === 0 ? 'none held up' : rule.map((c) => `${c.f} ${c.dir === 'gt' ? '>' : '<='} ${c.t}`).join(' & ')}`, trades: rule.length === 0 ? [] : tradesOf((d) => passesSurvival(rule, d), i) },
    ...pre.hypotheses.filter((h) => h.rules.kind === 'features').map((h) => ({ rule: h.id, trades: tradesOf((d) => d.eligibleAs === h.universe && passesFeatures(h.rules.conds!, d.f), i) })),
  ];
  return { barrier: b.cfgId, results: compareRules(rules, s0, { seed: 13, replicates }) };
});

mkdirSync(out, { recursive: true });
const result = {
  task: 'RES-5', label: 'exploration, not proof', dataset: `sha256:${manifestHash(dataset)}`, wall: wallDay(window), days: days.map((d) => d.day),
  decisions: drive.decisions.length, labelled: labelled.length, censored: drive.decisions.length - labelled.length, labelPastWall: drive.labelPastWall,
  survivalRate: labelled.length === 0 ? null : labelled.filter((x) => x.survived).length / labelled.length,
  trials: { featureTests: tests.length, rules: 1 + pre.hypotheses.filter((h) => h.rules.kind === 'features').length },
  tests, survivalRule: rule, comparison,
};
writeFileSync(join(out, 'results.json'), JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(JSON.stringify({ days: result.days.length, decisions: result.decisions, labelled: result.labelled, survivalRate: result.survivalRate, heldUp: tests.filter((x) => x.heldUp).map((x) => `${x.feature}@${x.ageMs / 60_000}m`), rule }, null, 2));
