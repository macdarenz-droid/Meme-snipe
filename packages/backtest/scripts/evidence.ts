// Pre-funding gate evidence, items 1 and 2 (BT-3), in one command. Replays every window of a day range through the
// engine `--replays` times (default 10), checks identical decision-log hashes, zero crashes, illegal states and
// unreconciled intents, and the ledger replay (LEDGER-REPLAY), then writes evidence.json and summary.md.
//
//   node packages/backtest/scripts/evidence.ts --fetch 2026-09-08..2026-09-21 [--out docs/evidence/bt3/<range>]
//   node packages/backtest/scripts/evidence.ts --dataset <window dir> --release data-FROM-TO [--out ...]
//   node packages/backtest/scripts/evidence.ts --dataset <window dir> [--dataset ...] --no-lead-in [--out ...]
//   node packages/backtest/scripts/evidence.ts --synthetic [--out docs/evidence/bt3/synthetic]
//   --fetch and --dataset need --sol-usd <hourly SOL/USD csv> (scripts/fetch-sol-usd.ts writes one; none is in the repo)
//   options: [--no-lead-in] [--replays 10] [--scenario conservative] [--seed bt3] [--work <dir>]
//
// --fetch downloads the assembled window releases (data-FROM-TO, DATA-1 mode=assemble) inside the range with gh.
// --no-lead-in is the labelled determinism-only mode: its output says gate: false and is never gate evidence.
// --synthetic writes a gate-shaped synthetic window (14 lead-in days recorded, SHA256SUMS, marked synthetic) to prove the
// run itself; its output says mode synthetic and gate: false, and is never gate evidence.
// Every mode reads practice days only: the shared holdout registry is synced first (as the study CLI does), and a day at
// or after the reserved holdout start, or inside a registered holdout, is refused before any download or run.
// The run refuses a working tree with changes outside docs/evidence, so the recorded commit is the code that ran.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { canonical } from '../../core/src/engine/log.ts';
import { SCENARIO_NAMES, type ScenarioName } from '../../core/src/fills/index.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { readSeries } from '../src/dataset/offchain.ts';
import { type Evidence, type EvidenceMode, type EvidenceWindow, RELEASE_TAG, runEvidence } from '../src/evidence.ts';
import { readHoldoutStore } from '../src/holdout.ts';
import { gitRegistryVcs } from '../src/registry-git.ts';
import { writeDataset } from '../src/dataset/writer.ts';
import { SOL_USD, syntheticRows } from '../src/dataset/synthetic.ts';

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

// Argument checks first: a refused run touches nothing (no git, registry or download).
const modes = ['fetch', 'dataset', 'synthetic'].filter(has);
if (modes.length !== 1) throw new Error('give exactly one of --fetch FROM..TO, --dataset DIR or --synthetic');
if (has('synthetic') && has('no-lead-in')) throw new Error('--synthetic and --no-lead-in are separate labelled modes; give one');
const mode: EvidenceMode = has('synthetic') ? 'synthetic' : has('no-lead-in') ? 'no-lead-in' : 'gate';
const fetchRange = (() => {
  if (!has('fetch')) return null;
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(flag('fetch'));
  if (!m) throw new Error('--fetch takes FROM..TO (YYYY-MM-DD..YYYY-MM-DD, both inclusive)');
  const [, from, to] = m as unknown as [string, string, string];
  // Never downloads a window reaching the holdout (runEvidence refuses its days again, registered windows included).
  if (to >= RESEARCH_CONFIG.holdout.fromDay) throw new Error(`--fetch ${from}..${to} reaches the reserved holdout start ${RESEARCH_CONFIG.holdout.fromDay}; evidence runs never read holdout days`);
  return { from, to };
})();
// A local folder is gate evidence only as a named release whose published SHA256SUMS it matches (BT-WALL W1).
if (has('release') && !has('dataset')) throw new Error('--release names the release a --dataset folder came from');
if (has('dataset') && mode === 'gate') {
  if (!has('release')) throw new Error('a --dataset folder is gate evidence only with --release data-FROM-TO (checked against its SHA256SUMS); use --no-lead-in for a labelled check');
  if (all('dataset').length !== 1) throw new Error('--release names one --dataset folder');
  if (!RELEASE_TAG.test(flag('release'))) throw new Error(`--release must be an assembled window release (data-FROM-TO), not ${flag('release')}`);
}
if (has('sol-usd') && has('synthetic')) throw new Error('--synthetic uses its own SOL/USD series');
if (has('dataset') && has('release')) {
  // The folder must be that release: its SHA256SUMS byte for byte the release's published one (runEvidence then checks
  // every file it reads against it). Checked here, with the arguments, so a mismatch refuses before anything else.
  const dir = resolve(flag('dataset'));
  const sums = mkdtempSync(join(tmpdir(), 'bt3-sums-'));
  execFileSync('gh', ['release', 'download', flag('release'), '--repo', REPO, '--pattern', 'SHA256SUMS', '--dir', sums], { stdio: 'inherit' });
  if (!existsSync(join(dir, 'SHA256SUMS')) || !readFileSync(join(dir, 'SHA256SUMS')).equals(readFileSync(join(sums, 'SHA256SUMS')))) {
    throw new Error(`${dir}: SHA256SUMS is not release ${flag('release')}'s`);
  }
}

const top = git('rev-parse', '--show-toplevel');
// The registry belongs to the code's own repository, never the working directory's (the study CLI's rule).
const registryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd: import.meta.dirname }).trim();
if (top !== registryRoot) throw new Error(`run this command from the code's repository (${registryRoot}), not ${top}`);
// Untrimmed: each porcelain line starts with a two-letter status that may begin with a space.
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l !== '' && !l.slice(3).startsWith('docs/evidence/'));
if (dirty.length > 0) throw new Error(`commit the code first; the evidence records the commit it ran on:\n${dirty.join('\n')}`);
const commit = git('rev-parse', 'HEAD');

const work = resolve(flag('work', mkdtempSync(join(tmpdir(), 'bt3-'))));
mkdirSync(work, { recursive: true });
const scenario = flag('scenario', 'conservative') as ScenarioName;
if (!SCENARIO_NAMES.includes(scenario)) throw new Error(`--scenario must be one of ${SCENARIO_NAMES.join(', ')}`);
// The shared holdout registry, synced from its remote branch before anything is read or downloaded (H1).
const registryVcs = gitRegistryVcs({
  root: registryRoot, relPath: RESEARCH_CONFIG.holdout.registryPath, remote: RESEARCH_CONFIG.holdout.registryRemote,
  branch: RESEARCH_CONFIG.holdout.registryBranch, fileName: 'registry.json', repo: RESEARCH_CONFIG.holdout.registryRepo,
});
registryVcs.check();
const registryPath = join(registryRoot, RESEARCH_CONFIG.holdout.registryPath);
const holdouts = existsSync(registryPath) ? readHoldoutStore(registryPath) : null;
// A labelled run's folder says so, so its files are never mistaken for gate evidence (checked before any download or run).
if (mode === 'no-lead-in' && has('out') && !resolve(flag('out')).endsWith('-no-lead-in')) throw new Error(`--no-lead-in output must go to a folder ending in -no-lead-in, not ${resolve(flag('out'))}`);

let windows: EvidenceWindow[];
let range: string;
if (has('synthetic')) {
  const dir = join(work, 'synthetic');
  writeDataset(dir, syntheticRows({ mints: 5, slots: 2.5 * 3600 * 24 }), { leadInDays: 14, sums: true });
  windows = [{ dir, release: 'synthetic' }];
  range = 'synthetic';
} else if (has('dataset')) {
  if (has('release')) windows = [{ dir: resolve(flag('dataset')), release: flag('release') }];
  else windows = all('dataset').map((d) => ({ dir: resolve(d) }));
  range = 'local';
} else {
  const { from, to } = fetchRange!;
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

const evidence: Evidence = runEvidence({
  windows, mode, holdouts, replays: Number(flag('replays', '10')), scenario, seed: flag('seed', 'bt3'),
  solUsd: has('synthetic') ? SOL_USD : readSeries(flag('sol-usd')),
  policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, commit, ledgerReplay: replayLedgerFile, workDir: work,
});

// Directories under the work folder are machine-specific; the record keeps their names only.
const record = { ...evidence, windows: evidence.windows.map((w) => ({ ...w, dir: w.dir.startsWith(work) ? w.dir.slice(work.length + 1) : w.dir })) };
const label = mode === 'no-lead-in' ? `${range}-no-lead-in` : range;
const what = mode === 'gate' ? 'Gate mode: windows assembled with their 14 lead-in days and checked against SHA256SUMS.'
  : mode === 'synthetic' ? 'Synthetic mode: a gate-shaped synthetic window that proves the run itself; never gate evidence.'
    : 'Labelled no-lead-in mode: a determinism-only check, never gate evidence.';
const out = resolve(flag('out', join(top, 'docs/evidence/bt3', label)));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'evidence.json'), `${JSON.stringify(JSON.parse(canonical(record)), null, 2)}\n`);
const line = (w: (typeof record.windows)[number]): string =>
  `| ${w.window.from} → ${w.window.toExclusive} | ${w.release ?? '-'} | ${w.leadInDays} | ${w.hashes[0]!.slice(0, 16)}… (${new Set(w.hashes).size} distinct of ${w.hashes.length}) | ${w.crashes} | ${w.illegalStates} | ${w.unreconciledIntents} | ${w.ledgerReplay.ok ? 'ok' : 'FAIL'} | ${w.counts['decisions']} | ${w.pass ? 'pass' : 'FAIL'} |`;
writeFileSync(join(out, 'summary.md'), [
  `# BT-3 evidence: ${label}`, '',
  `Pre-funding gate items 1 and 2. ${what}`, '',
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
