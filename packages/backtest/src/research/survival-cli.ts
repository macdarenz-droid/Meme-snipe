// RES-5 survival study on practice days (docs/research/survival.md). Exploration, not proof. Two commands, one look:
//   node packages/backtest/src/research/survival-cli.ts freeze --dataset <dir> --sol-usd <file> [--window <file>] [--registry <file>]
//     chooses the rule on the find-days, reads no check-day label, writes research/survival/frozen.json (refuses when
//     one exists or is committed). Commit frozen.json before running `check`.
//   node packages/backtest/src/research/survival-cli.ts check --dataset <dir> --sol-usd <file> [same options]
//     logs the attempt in research/survival/runs.log first, then refuses unless frozen.json is committed, unchanged
//     against HEAD and matches this dataset and these find-days; refuses to overwrite results.json.
// The paths are fixed (no --out): the one look is the one in this repository's history.
// The wall is RES-3's committed one (research/signals/window.json), checked against RESEARCH_CONFIG.holdout and BT-2's
// holdout store (--registry for another store file); --window may only move it earlier.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { loadDay, loadManifest, manifestHash, verifySums } from '../dataset/dataset.ts';
import { readSeries } from '../dataset/offchain.ts';
import type { DatasetRow } from '../dataset/rows.ts';
import { solUsdAsOf } from './candidates.ts';
import { PLAN_BARRIERS, scoreCandidates } from './outcome.ts';
import { addDays, assertReadable, isPracticeDay, melbourneDay, readableDays, wallDay } from './practice.ts';
import { researchWindow } from './wall.ts';
import { collectSurvival, type SurvivalDecision } from './survival.ts';
import { featureTests, type LabelledDecision, PERMUTATIONS, splitDays } from './survival-analysis.ts';
import { compareRules, type FeatureCond, type FrozenRule, freezeRule, passesFeatures, passesSurvival } from './survival-compare.ts';
import { labelDecisions } from './survival-outcome.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const [command, ...args] = process.argv.slice(2);
if (command !== 'freeze' && command !== 'check') throw new Error('usage: survival-cli.ts freeze|check --dataset <dir> --sol-usd <file> ...');
const flag = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

/** Registered once, not run options: the seed and the counts are fixed here and written into frozen.json. */
const SEED = 'res5-1';
const BOOTSTRAP_REPLICATES = 2000;

const out = join(ROOT, 'research', 'survival');
const FROZEN = 'research/survival/frozen.json';
const frozenPath = join(ROOT, FROZEN);
const git = (...a: string[]) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
/** frozen.json is tracked by git (`git ls-files --error-unmatch`). */
const frozenTracked = (): boolean => git('ls-files', '--error-unmatch', '--', FROZEN).status === 0;
mkdirSync(out, { recursive: true });
const runsLog = join(out, 'runs.log');
// Every check attempt is logged before anything can refuse it, so refused looks are counted too.
if (command === 'check') appendFileSync(runsLog, `${new Date().toISOString()} check attempt ${JSON.stringify(args)}\n`);
if (args.includes('--out')) throw new Error('--out is not an option: the paths are fixed under research/survival');

const dataset = flag('dataset');

// The wall: the committed window, checked against RESEARCH_CONFIG.holdout and BT-2's holdout store (wall.ts).
const window = researchWindow({ ...(args.includes('--window') ? { windowPath: flag('window') } : {}), ...(args.includes('--registry') ? { storePath: flag('registry') } : {}) });
verifySums(dataset);
const manifest = loadManifest(dataset);
const datasetHash = `sha256:${manifestHash(dataset)}`;
const files = readableDays(window, manifest.days);
for (const d of files) assertReadable(window, d.day);
const solUsd = solUsdAsOf(readSeries(flag('sol-usd')), 2 * 3_600_000);
function* rows(): Generator<DatasetRow> {
  for (const d of files) yield* loadDay(dataset, d);
}

/** The practice days (Melbourne) the readable files cover, from the window and the manifest alone: no label is read. */
const practiceDays = (): string[] => {
  if (files.length === 0) return [];
  const out: string[] = [];
  for (let d = melbourneDay(Date.parse(`${files[0]!.day}T00:00:00Z`)); d < wallDay(window); d = addDays(d, 1)) if (isPracticeDay(window, d)) out.push(d);
  return out;
};
const split = splitDays(practiceDays());

// Feature stage over every readable row (no labels), then labels for one side only.
const drive = collectSurvival(rows(), { window, policy: TRIAL_POLICY, solUsd });
const labelSide = (days: readonly string[]): (LabelledDecision & { readonly d: SurvivalDecision })[] => {
  const D = new Set(days);
  const side = drive.decisions.filter((d) => D.has(d.day));
  const labels = new Map(labelDecisions(rows(), side.map(({ id, pool, labelAtMs }) => ({ id, pool, labelAtMs })), window).map((x) => [x.id, x.label]));
  return side.flatMap((d) => {
    const l = labels.get(d.id);
    return l === null || l === undefined ? [] : [{ id: d.id, day: d.day, ageMs: d.ageMs, stratum: d.stratum, cluster: d.creator ?? d.id, features: d.features, survived: l.survived, d }];
  });
};

interface Frozen {
  readonly task: 'RES-5';
  readonly rule: FrozenRule;
  readonly dataset: string;
  readonly findDays: readonly string[];
  readonly checkDays: readonly string[];
  readonly permutations: number;
  readonly bootstrapReplicates: number;
  readonly seed: string;
  readonly decisions: number;
  readonly findLabelled: number;
}

if (command === 'freeze') {
  if (existsSync(frozenPath) || frozenTracked()) throw new Error(`${FROZEN} exists or is committed: the rule is frozen once`);
  const find = labelSide(split.find);
  const rule = freezeRule(find, practiceDays(), PERMUTATIONS, 17);
  const frozen: Frozen = {
    task: 'RES-5', rule, dataset: datasetHash, findDays: split.find, checkDays: split.check, permutations: PERMUTATIONS,
    bootstrapReplicates: BOOTSTRAP_REPLICATES, seed: SEED, decisions: drive.decisions.length, findLabelled: find.length,
  };
  writeFileSync(frozenPath, JSON.stringify(frozen, null, 2) + '\n');
  console.log(JSON.stringify({ frozen: frozenPath, rule: rule.none ?? rule.conds, hash: rule.hash, findDays: split.find.length, checkDays: split.check.length }, null, 2));
} else {
  if (!existsSync(frozenPath)) throw new Error(`${FROZEN} is missing: run freeze and commit frozen.json first`);
  if (!frozenTracked()) throw new Error(`${FROZEN} is not committed: commit it before the check`);
  if (git('diff', '--quiet', 'HEAD', '--', FROZEN).status !== 0) throw new Error(`${FROZEN} differs from its committed version`);
  const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as Frozen;
  if (frozen.dataset !== datasetHash) throw new Error(`frozen.json was made on ${frozen.dataset}, this dataset is ${datasetHash}`);
  if (JSON.stringify(frozen.findDays) !== JSON.stringify(split.find) || JSON.stringify(frozen.checkDays) !== JSON.stringify(split.check)) throw new Error('frozen.json was made on other find- or check-days');
  const resultsPath = join(out, 'results.json');
  if (existsSync(resultsPath)) throw new Error(`${resultsPath} exists: the check-days are looked at once`);
  appendFileSync(runsLog, `${new Date().toISOString()} check ${datasetHash} rule ${frozen.rule.hash}\n`);
  // Attempts so far, refused ones included.
  const runs = readFileSync(runsLog, 'utf8').split('\n').filter((l) => l.includes(' check attempt ')).length;
  const rule = frozen.rule;

  const findSide = labelSide(frozen.findDays);
  const checkSide = labelSide(frozen.checkDays);
  // Descriptive find/check report of every feature (never chooses the rule).
  const tests = featureTests([...findSide, ...checkSide], { find: frozen.findDays, check: frozen.checkDays }, frozen.bootstrapReplicates, frozen.permutations, 11);
  const C = new Set(frozen.checkDays);
  const eligible = drive.decisions.filter((d) => d.eligibleAs !== null && C.has(d.day));
  const scored = new Map(scoreCandidates(rows(), eligible.map(({ id, pool, decisionSlot, decisionMs, solUsd: px }) => ({ id, pool, decisionSlot, decisionMs, solUsd: px })), {
    window, policy: TRIAL_POLICY, fills: FILL_CONFIG, scenario: 'conservative', barriers: PLAN_BARRIERS.slice(0, 2), seed: frozen.seed, entryMinOutBelowBps: RESEARCH_CONFIG.s0.entryMinOutBelowBps,
  }).map((o) => [o.id, o]));
  const pre = JSON.parse(readFileSync(join(ROOT, 'research', 'edge', 'preregistration.json'), 'utf8')) as { hypotheses: { id: string; universe: 'U1' | 'U2'; rules: { kind: string; conds?: FeatureCond[] } }[] };
  const tradesOf = (pick: (d: SurvivalDecision) => boolean, barrier: number) => eligible.filter(pick).flatMap((d) => {
    const o = scored.get(d.id);
    const l = o?.labels[barrier];
    return o === undefined || o.noQuote || l === undefined || l.rNet === null ? [] : [{ day: d.day, rNet: l.rNet }];
  });
  const comparison = PLAN_BARRIERS.slice(0, 2).map((b, i) => {
    const s0 = tradesOf(() => true, i);
    const rules = [
      { rule: 'S0 (every eligible decision)', trades: s0 },
      { rule: `survival rule: ${rule.none ?? `${rule.ageMs! / 60_000} min, ${rule.conds.map((c) => `${c.f} ${c.dir === 'gt' ? '>' : '<='} ${c.t}`).join(' & ')}`} (sha256 ${rule.hash.slice(0, 12)})`, trades: rule.conds.length === 0 ? [] : tradesOf((d) => passesSurvival(rule, d), i) },
      ...pre.hypotheses.filter((h) => h.rules.kind === 'features').map((h) => ({ rule: `${h.id}: not RES-4's registered test; its G1 is BT-2's SPA`, trades: tradesOf((d) => d.eligibleAs === h.universe && passesFeatures(h.rules.conds!, d.f), i) })),
    ];
    return { barrier: b.cfgId, note: 'unadjusted, 10 intervals, exploration', results: compareRules(rules, s0, { seed: 13, replicates: frozen.bootstrapReplicates }) };
  });
  const result = {
    task: 'RES-5', label: 'exploration, not proof', dataset: datasetHash, wall: wallDay(window), checkRun: runs, frozen,
    labelled: { find: findSide.length, check: checkSide.length },
    survivalRate: checkSide.length + findSide.length === 0 ? null : [...findSide, ...checkSide].filter((x) => x.survived).length / (checkSide.length + findSide.length),
    trials: { featureTests: tests.length, ruleSelectionTests: rule.trials, rules: 1 + pre.hypotheses.filter((h) => h.rules.kind === 'features').length },
    tests, comparison,
  };
  writeFileSync(resultsPath, JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(JSON.stringify({ checkRun: runs, rule: rule.none ?? rule.conds, labelled: result.labelled }, null, 2));
}
