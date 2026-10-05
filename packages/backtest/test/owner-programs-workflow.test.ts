// BT-1e: the owner-programs workflow and its two CI scripts. The collector and the publisher run against a fake `gh`
// that serves fixture releases and records what would be published.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeBase58, encodeBase58, isOnCurve } from '../../core/src/chain/index.ts';
import { bps } from '../../core/src/units/index.ts';
import { writeOwnerPrograms } from '../src/dataset/owner-programs.ts';
import type { AmmSwapRow } from '../src/dataset/rows.ts';
import { writeDataset } from './dataset-writer.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const WF = read('.github/workflows/owner-programs.yml');
const COLLECT = join(root, 'packages/backtest/ci/owner-programs-collect.sh');
const PUBLISH = join(root, 'packages/backtest/ci/publish-owner-programs.sh');

/** The workflow's jobs and steps as text blocks (enough structure for these checks, no YAML parser needed). */
const block = (text: string, start: string, indent: number): string => {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l === start || l.trimEnd() === start);
  if (i < 0) throw new Error(`no ${start}`);
  const out = [lines[i]!];
  for (let j = i + 1; j < lines.length && (lines[j]!.trim() === '' || lines[j]!.search(/\S/) > indent); j++) out.push(lines[j]!);
  return out.join('\n');
};
const steps = (job: string): string[] => job.split(/\n(?=      - )/).slice(1);

describe('workflow', () => {
  const fetchJob = block(WF, '  fetch:', 2);
  const publishJob = block(WF, '  publish:', 2);

  test('manual dispatch only, its own concurrency group never cancelled, read-only by default, dry run by default', () => {
    expect(block(WF, 'on:', 0)).toMatch(/^on:\n  workflow_dispatch:\n/);
    expect(WF).not.toMatch(/^\s+(push|pull_request|schedule|workflow_run|pull_request_target):/m);
    expect(block(WF, 'permissions:', 0)).toBe('permissions:\n  contents: read\n');
    expect(block(WF, 'concurrency:', 0)).toBe('concurrency:\n  group: owner-programs\n  cancel-in-progress: false\n');
    expect(block(WF, '      dry_run:', 6)).toMatch(/default: true/);
  });

  test('least privilege: the RPC key only in the fetch step, the write token only in the publish job, never together', () => {
    expect(fetchJob).toMatch(/permissions:\n      contents: read\n/);
    expect(publishJob).toMatch(/permissions:\n      contents: write # used only by the "Publish" step\n/);
    expect(WF.match(/secrets\./g)).toHaveLength(1);
    const withKey = steps(fetchJob).filter((s) => s.includes('secrets.HELIUS_API_KEY'));
    expect(withKey).toHaveLength(1);
    expect(withKey[0]).toContain('name: Fetch the owner programs');
    expect(withKey[0]).toContain('if: ${{ !inputs.dry_run }}');
    expect(publishJob).not.toContain('secrets.');
    expect(publishJob).toContain('if: ${{ !inputs.dry_run }}');
    // The write token reaches only the publish step, and that step runs the publisher under env -i.
    const tokenSteps = steps(publishJob).filter((s) => s.includes('github.token'));
    expect(tokenSteps).toHaveLength(1);
    expect(tokenSteps[0]).toContain('env -i PATH=/usr/bin:/bin GH_TOKEN="$GH_TOKEN"');
    expect(tokenSteps[0]).toContain('/usr/bin/bash packages/backtest/ci/publish-owner-programs.sh');
    // The dry-run plan step has no key and no token.
    const plan = steps(fetchJob).find((s) => s.includes('name: Plan (dry run)'))!;
    expect(plan).toContain('--dry-run');
    expect(plan).not.toMatch(/secrets\.|github\.token|env:/);
  });

  test('inputs and secrets reach the shell only as env; actions pinned to a commit; no credentials kept', () => {
    const runs = WF.split('\n').reduce<string[]>((acc, line, i, all) => {
      if (/^\s+run: /.test(line)) {
        const indent = line.search(/\S/);
        const b = [line];
        for (let j = i + 1; j < all.length && (all[j]!.trim() === '' || all[j]!.search(/\S/) > indent); j++) b.push(all[j]!);
        acc.push(b.join('\n'));
      }
      return acc;
    }, []);
    expect(runs.length).toBeGreaterThanOrEqual(4);
    for (const r of runs) expect(r).not.toMatch(/\$\{\{\s*(secrets|inputs|github\.event)\./);
    for (const line of WF.split('\n').filter((l) => /\buses:/.test(l))) expect(line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    expect(WF.match(/^\s+persist-credentials: false$/gm)).toHaveLength(2);
    expect(WF).not.toMatch(/set-output|GITHUB_ENV|GITHUB_PATH|actions\/cache/);
    // The artifact carries only the supplement, its manifest and SHA256SUMS (public data), and only on a real run.
    const upload = steps(fetchJob).find((s) => s.includes('upload-artifact'))!;
    expect(upload).toContain('if: ${{ !inputs.dry_run }}');
    expect(upload).toContain('path: ${{ runner.temp }}/out/');
  });
});

// ---- the CI scripts against a fake gh ----

const raw = (label: string): string => encodeBase58(createHash('sha256').update(label).digest());
const pda = (label: string): string => {
  for (let k = 0; ; k++) {
    const a = raw(`${label}:${k}`);
    if (!isOnCurve(decodeBase58(a))) return a;
  }
};
const T0 = 1_759_536_000;
const amm = (k: number, owner: string): AmmSwapRow => ({
  kind: 'amm', slot: BigInt(1000 + k), blockTime: T0 + k, txIdx: 1, evIdx: 0, signature: `s${k}`, pool: raw('pool'), baseMint: raw('mint'), quoteMint: 'Q', side: 'buy',
  mode: 'exact-base', amount: 1n, baseAmount: 1n, quoteAmount: 0n, userQuote: 0n, pre: { baseReserve: 1n, quoteVault: 0n, virtualQuoteReserves: 0n },
  fees: { split: { lp: bps(0), protocol: bps(0), creator: bps(0) }, buybackFeeBps: bps(0), instruction: 'v1' }, baseSupply: 0n, ixName: 'buy', user: 'SIGNER',
  userTokenAccount: raw(`ata${k}`), userTokenOwner: owner, lpFee: 0n, quoteLpAdjusted: 0n, extraHex: '',
});

let tmp = '';
let releases = '';
let bin = '';
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** A release directory in the published layout: flat DAY__file names, manifest.json, SHA256SUMS; meta.json for the fake gh. */
const release = (tag: string, owners: string[], author = 'github-actions[bot]', draft = false) => {
  const src = join(tmp, `src-${tag}`);
  writeDataset(src, owners.map((o, k) => amm(k, o)));
  const dir = join(releases, tag);
  mkdirSync(dir, { recursive: true });
  for (const e of readdirSync(src, { recursive: true, withFileTypes: true }).filter((x) => x.isFile())) {
    const rel = join(e.parentPath, e.name).slice(src.length + 1);
    copyFileSync(join(src, rel), join(dir, rel.startsWith('days/') ? `${rel.split('/')[1]}__${rel.split('/')[2]}` : rel));
  }
  writeFileSync(join(dir, 'SHA256SUMS'), readdirSync(dir).sort().map((n) => `${sha(join(dir, n))}  ${n}`).join('\n') + '\n');
  writeFileSync(join(tmp, `meta-${tag}.json`), JSON.stringify({ author, draft }));
  return dir;
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bt1e-wf-'));
  releases = join(tmp, 'releases');
  bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  // gh: release view (author/isDraft), download (all assets, or one --pattern), create (records and stores the files).
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${tmp}/gh-calls"
[ "$1 $2" = "release view" ] && {
  m="${tmp}/meta-$3.json"; [ -f "$m" ] || { echo "release not found" >&2; exit 1; }
  if [[ "$*" == *author* ]]; then jq -r '"\\(.author) \\(.draft)"' "$m"; else jq -r '"draft \\(.draft)"' "$m"; fi; exit 0; }
[ "$1 $2" = "release download" ] && {
  tag=$3; shift 3; dir=""; pat=""
  while [ $# -gt 0 ]; do case "$1" in --dir) dir=$2; shift 2;; --pattern) pat=$2; shift 2;; *) shift;; esac; done
  if [ -n "$pat" ]; then cp "${releases}/$tag/$pat" "$dir/"; else cp "${releases}/$tag/"* "$dir/"; fi; exit 0; }
[ "$1 $2" = "release create" ] && {
  tag=$3; mkdir -p "${releases}/$tag"; shift 3
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift
  cp "$@" "${releases}/$tag/"; printf '{"author":"github-actions[bot]","draft":false}' > "${tmp}/meta-$tag.json"; exit 0; }
echo "gh stub: $*" >&2; exit 1
`);
  chmodSync(join(bin, 'gh'), 0o755);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sh = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH']}`, GITHUB_REPOSITORY: 'o/r', GH_BIN: join(bin, 'gh'), ...env } });

describe('owner-programs-collect.sh', () => {
  const A = Array.from({ length: 5 }, (_, k) => pda(`a${k}`));
  const B = [A[0]!, pda('b1'), pda('b2')];

  test('reads each release in turn, checked against its SHA256SUMS, and writes the owners and the dataset hashes', () => {
    const ra = release('data-2025-10-04-2025-10-05', A);
    const rb = release('data-2025-10-05-2025-10-06', B);
    const out = join(tmp, 'collect');
    const r = sh(COLLECT, [out, join(tmp, 'work'), 'data-2025-10-04-2025-10-05', 'data-2025-10-05-2025-10-06']);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(out, 'owners.txt'), 'utf8').trim().split('\n')).toEqual([...new Set([...A, ...B])].sort());
    expect(JSON.parse(readFileSync(join(out, 'datasets.json'), 'utf8'))).toEqual([
      { tag: 'data-2025-10-04-2025-10-05', manifestSha256: sha(join(ra, 'manifest.json')) },
      { tag: 'data-2025-10-05-2025-10-06', manifestSha256: sha(join(rb, 'manifest.json')) },
    ]);
    // One release at a time on disk: each work folder is gone after it is read.
    expect(readdirSync(join(tmp, 'work'))).toEqual([]);
  });

  test.each([
    ['a tag that is not a dataset release', ['data-day-2025-10-04'], /is not a dataset release/],
    ['a release someone else made', ['data-2025-10-06-2025-10-07'], /is not a published release of this repository's workflow \(someone false\)/],
    ['a draft', ['data-2025-10-07-2025-10-08'], /\(github-actions\[bot\] true\)/],
    ['a missing release', ['data-2025-10-09-2025-10-10'], /release data-2025-10-09-2025-10-10 not found/],
    ['the same release twice', ['data-2025-10-04-2025-10-05', 'data-2025-10-04-2025-10-05'], /listed twice/],
  ])('refuses %s', (_, tags, why) => {
    if (!existsSync(join(releases, 'data-2025-10-06-2025-10-07'))) release('data-2025-10-06-2025-10-07', A, 'someone');
    if (!existsSync(join(releases, 'data-2025-10-07-2025-10-08'))) release('data-2025-10-07-2025-10-08', A, 'github-actions[bot]', true);
    if (!existsSync(join(releases, 'data-2025-10-04-2025-10-05'))) release('data-2025-10-04-2025-10-05', A);
    const r = sh(COLLECT, [join(tmp, `c-${Math.random()}`), join(tmp, 'w2'), ...tags]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(why);
  });

  test('refuses a release whose files do not match its SHA256SUMS', () => {
    const dir = release('data-2025-10-11-2025-10-12', A);
    const day = readdirSync(dir).find((n) => n.includes('__amm_trades'))!;
    writeFileSync(join(dir, day), Buffer.concat([readFileSync(join(dir, day)), Buffer.from('x')]));
    const r = sh(COLLECT, [join(tmp, 'c-bad'), join(tmp, 'w3'), 'data-2025-10-11-2025-10-12']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not match SHA256SUMS/);
  });
});

describe('publish-owner-programs.sh', () => {
  const DS = [{ tag: 'data-2025-10-04-2025-10-05', manifestSha256: 'a'.repeat(64) }];
  const assets = (name: string, rows = [{ owner: pda('p1'), program: raw('prog') }, { owner: pda('p2'), program: null }], over: Record<string, unknown> = {}) => {
    const dir = join(tmp, name);
    writeOwnerPrograms(dir, rows, { calls: 1, source: 'helius', fetchedAt: '2026-10-04T01:02:03.000Z', datasets: DS });
    if (Object.keys(over).length) {
      const m = JSON.parse(readFileSync(join(dir, 'owner-programs.manifest.json'), 'utf8'));
      writeFileSync(join(dir, 'owner-programs.manifest.json'), JSON.stringify({ ...m, ...over }));
    }
    writeFileSync(join(dir, 'SHA256SUMS'), ['owner-programs.jsonl', 'owner-programs.manifest.json'].map((n) => `${sha(join(dir, n))}  ${n}`).join('\n') + '\n');
    return dir;
  };

  test('publishes owner-programs-DAY in one call with exactly the three files, then accepts the same supplement again', () => {
    const r = sh(PUBLISH, [assets('pub1')]);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(releases, 'owner-programs-2026-10-04')).sort()).toEqual(['SHA256SUMS', 'owner-programs.jsonl', 'owner-programs.manifest.json']);
    const create = readFileSync(join(tmp, 'gh-calls'), 'utf8').split('\n').filter((l) => l.startsWith('release create'));
    expect(create).toHaveLength(1);
    expect(create[0]).toContain('--prerelease');
    expect(create[0]).toContain('data-2025-10-04-2025-10-05');
    const again = sh(PUBLISH, [assets('pub2')]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('already published with the same supplement; left unchanged');
  });

  test('never edits an existing release with other content', () => {
    const r = sh(PUBLISH, [assets('pub3', [{ owner: pda('p9'), program: null }])]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('exists with other content; delete it to republish');
  });

  test.each([
    ['a manifest that does not match the file', { sha256: 'b'.repeat(64) }],
    ['a URL as the source', { source: 'https://mainnet.helius-rpc.com/?api-key=x' }],
    ['no datasets', { datasets: [] }],
    ['a dataset that is not a release tag', { datasets: [{ tag: '/tmp/x', manifestSha256: 'a'.repeat(64) }] }],
    ['a wrong row count', { rows: 7 }],
  ])('refuses %s', (_, over) => {
    const r = sh(PUBLISH, [assets(`bad-${Math.random()}`, undefined, over)]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not describe owner-programs.jsonl/);
  });

  test('refuses a tampered file and any extra file', () => {
    const t = assets('tamper');
    writeFileSync(join(t, 'owner-programs.jsonl'), 'x\n');
    expect(sh(PUBLISH, [t]).stderr).toMatch(/SHA256SUMS does not match/);
    const extra = assets('extra');
    writeFileSync(join(extra, 'owner-programs.plan.json'), '{}');
    expect(sh(PUBLISH, [extra]).stderr).toMatch(/expected exactly/);
  });
});
