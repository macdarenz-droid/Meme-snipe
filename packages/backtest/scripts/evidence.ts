// Pre-funding gate evidence, items 1 and 2 (BT-3), in one command. Replays every window of a day range through the
// engine `--replays` times (default 10), checks identical decision-log hashes, zero crashes, illegal states and
// unreconciled intents, and the ledger replay (LEDGER-REPLAY), then writes evidence.json and summary.md.
//
//   node packages/backtest/scripts/evidence.ts --fetch 2026-09-08..2026-09-21 [--out docs/evidence/bt3/<range>]
//   node packages/backtest/scripts/evidence.ts --dataset <window dir> [--dataset ...] [--out ...]
//   node packages/backtest/scripts/evidence.ts --synthetic [--out docs/evidence/bt3/synthetic]
//   options: [--no-lead-in] [--replays 10] [--sol-usd packages/backtest/data/sol-usd-1h.csv] [--scenario conservative]
//            [--seed bt3] [--work <dir>]
//
// --fetch downloads the assembled window releases (data-FROM-TO, DATA-1 mode=assemble) inside the range with gh.
// --no-lead-in is the labelled determinism-only mode: its output says gate: false and is never gate evidence.
// --synthetic writes a gate-shaped synthetic window (14 lead-in days recorded, SHA256SUMS) to prove the run itself.
// The run refuses a working tree with changes outside docs/evidence, so the recorded commit is the code that ran.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { canonical } from '../../core/src/engine/log.ts';
import { SCENARIO_NAMES, type ScenarioName } from '../../core/src/fills/index.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { readSeries } from '../src/dataset/offchain.ts';
import { type Evidence, type EvidenceWindow, runEvidence } from '../src/evidence.ts';
import { writeDataset } from '../test/dataset-writer.ts';
import { SOL_USD, syntheticRows } from '../test/synthetic.ts';

const REPO = 'macdarenz-droid/Meme-snipe';
const args = process.argv.slice(2);
const has = (name: string): boolean => args.includes(`--${name}`);
const flag = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : fallback;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const all = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]!] : []));
const git = (...a: string[]): string => execFileSync('git', a, { encoding: 'utf8' }).trim();

const top = git('rev-parse', '--show-toplevel');
const dirty = git('status', '--porcelain').split('\n').filter((l) => l !== '' && !l.slice(3).startsWith('docs/evidence/'));
if (dirty.length > 0) throw new Error(`commit the code first; the evidence records the commit it ran on:\n${dirty.join('\n')}`);
const commit = git('rev-parse', 'HEAD');

const modes = ['fetch', 'dataset', 'synthetic'].filter(has);
if (modes.length !== 1) throw new Error('give exactly one of --fetch FROM..TO, --dataset DIR or --synthetic');
const work = resolve(flag('work', mkdtempSync(join(tmpdir(), 'bt3-'))));
mkdirSync(work, { recursive: true });
const scenario = flag('scenario', 'conservative') as ScenarioName;
if (!SCENARIO_NAMES.includes(scenario)) throw new Error(`--scenario must be one of ${SCENARIO_NAMES.join(', ')}`);

let windows: EvidenceWindow[];
let range: string;
if (has('synthetic')) {
  const dir = join(work, 'synthetic');
  writeDataset(dir, syntheticRows({ mints: 5, slots: 2.5 * 3600 * 24 }), { leadInDays: 14, sums: true });
  windows = [{ dir, release: 'synthetic' }];
  range = 'synthetic';
} else if (has('dataset')) {
  windows = all('dataset').map((d) => ({ dir: resolve(d) }));
  range = 'local';
} else {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(flag('fetch'));
  if (!m) throw new Error('--fetch takes FROM..TO (YYYY-MM-DD..YYYY-MM-DD, both inclusive)');
  const [, from, to] = m as unknown as [string, string, string];
  // REST, not GraphQL: the release listing through gh api.
  const tags = execFileSync('gh', ['api', '--paginate', `repos/${REPO}/releases`, '--jq', '.[].tag_name'], { encoding: 'utf8' })
    .split('\n').filter((t) => {
      const w = /^data-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/.exec(t);
      return w !== null && w[1]! >= from && w[2]! <= to;
    }).sort();
  if (tags.length === 0) throw new Error(`no assembled window release (data-FROM-TO) inside ${from}..${to}`);
  windows = tags.map((tag) => {
    const dir = join(work, tag);
    execFileSync('gh', ['release', 'download', tag, '--repo', REPO, '--dir', dir], { stdio: 'inherit' });
    return { dir, release: tag };
  });
  range = `${from}..${to}`;
}

const mode = has('no-lead-in') ? 'no-lead-in' : 'gate';
const evidence: Evidence = runEvidence({
  windows, mode, replays: Number(flag('replays', '10')), scenario, seed: flag('seed', 'bt3'),
  solUsd: has('synthetic') ? SOL_USD : readSeries(flag('sol-usd', join(top, 'packages/backtest/data/sol-usd-1h.csv'))),
  policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, commit, ledgerReplay: replayLedgerFile, workDir: work,
});

// Directories under the work folder are machine-specific; the record keeps their names only.
const record = { ...evidence, windows: evidence.windows.map((w) => ({ ...w, dir: w.dir.startsWith(work) ? w.dir.slice(work.length + 1) : w.dir })) };
const label = mode === 'no-lead-in' ? `${range}-no-lead-in` : range;
const out = resolve(flag('out', join(top, 'docs/evidence/bt3', label)));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'evidence.json'), `${JSON.stringify(JSON.parse(canonical(record)), null, 2)}\n`);
const line = (w: (typeof record.windows)[number]): string =>
  `| ${w.window.from} → ${w.window.toExclusive} | ${w.release ?? '-'} | ${w.leadInDays} | ${w.hashes[0]!.slice(0, 16)}… (${new Set(w.hashes).size} distinct of ${w.hashes.length}) | ${w.crashes} | ${w.illegalStates} | ${w.unreconciledIntents} | ${w.ledgerReplay.ok ? 'ok' : 'FAIL'} | ${w.counts['decisions']} | ${w.pass ? 'pass' : 'FAIL'} |`;
writeFileSync(join(out, 'summary.md'), [
  `# BT-3 evidence: ${label}`, '',
  `Pre-funding gate items 1 and 2. ${evidence.gate ? 'Gate mode: windows assembled with their 14 lead-in days and checked against SHA256SUMS.' : 'Labelled no-lead-in mode: a determinism-only check, never gate evidence.'}`, '',
  `- Result: **${evidence.pass ? 'pass' : 'FAIL'}**`,
  `- Commit: \`${commit}\``,
  `- Replays per window: ${evidence.replays}; scenario ${scenario}; seed ${evidence.seed}`,
  `- Configs: fills ${evidence.configs.fills}, research ${evidence.configs.research}, policy ${evidence.configs.policy}`,
  `- Scanner revisions: ${[...new Set(record.windows.flatMap((w) => w.scannerRevisions))].join(', ') || 'none recorded'}`, '',
  '| Window | Release | Lead-in days | Decision-log hash | Crashes | Illegal | Unreconciled | Ledger replay | Decisions | Result |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...record.windows.map(line), '',
  'Full hashes, counts, manifest and SHA256SUMS digests: `evidence.json`.', '',
].join('\n'));
console.log(`${evidence.pass ? 'pass' : 'FAIL'}: ${out}`);
process.exitCode = evidence.pass ? 0 : 1;
