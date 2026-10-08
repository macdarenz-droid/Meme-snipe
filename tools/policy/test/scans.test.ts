// Unit tests: allowlist, typosquat, workflow, lint configuration, secrets and repository reading (B-M30-01 logic 2, 3, 5, 6).
// Ported from C01: the lockfile is pnpm-lock.yaml, CI installs with pnpm, and the allowlist licence comparison runs on
// the installed packages (installed.ts checkLicences). Each C01 case is kept against its pnpm counterpart.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { checkAllowlist, isUnnamedReviewer, parseTable } from '../allowlist.ts';
import { wallClockNowMs } from '../clock.ts';
import { AUDIT_JOB, AUDIT_SCHEDULE_WORKFLOW, CI_CONCURRENCY_GROUP, CI_JOB_IF, INTEGRATION_BRANCH } from '../config.ts';
import { formatFindings, type Finding } from '../finding.ts';
import { checkLicences, type InstalledPackage } from '../installed.ts';
import { checkLintConfig } from '../lintconfig.ts';
import type { PnpmLock } from '../lockfile.ts';
import { readRepo, type RepoSnapshot } from '../repo.ts';
import { scopeOf } from '../scope.ts';
import { fingerprint, isRegularFile, readAllowlist, scanFiles, scanMain, scanText } from '../secrets.ts';
import { checkTyposquats, editDistance, lookalikeOf, normalise } from '../typosquat.ts';
import { checkRun, checkWorkflows, triggers, yamlAnchors } from '../workflows.ts';
import { capture, codes, goodSnapshot, REPO_ROOT, runBin } from './helpers.ts';

const lockOf = (s: RepoSnapshot): PnpmLock => s.lock as PnpmLock;
/** Adds the package `id` (name@version) to the lockfile, reached from `importer` as `depName` (an alias when it differs). */
function addDep(s: RepoSnapshot, depName: string, id: string, importer = '.'): void {
  const lock = lockOf(s);
  const imp = lock.importers[importer] ?? (lock.importers[importer] = {});
  const name = id.slice(0, id.indexOf('@', 1));
  const version = name === depName ? id.slice(name.length + 1) : id;
  imp.devDependencies = { ...imp.devDependencies, [depName]: { specifier: version, version } };
  lock.packages[id] = { resolution: { integrity: 'sha512-x' } };
  lock.snapshots[id] = {};
}
/** Adds `id` to the lockfile's packages only (a package no importer reaches; the typosquat check reads them all). */
function addPackage(s: RepoSnapshot, id: string): void {
  lockOf(s).packages[id] = { resolution: { integrity: 'sha512-x' } };
}
const installed = (name: string, version: string, license: string | null): InstalledPackage =>
  ({ dir: `node_modules/.pnpm/${name}@${version}/node_modules/${name}`, name, version, license, scripts: {}, invalid: false });
const tmp = mkdtempSync(join(tmpdir(), 'policy-scan-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('allowlist (DEPENDENCIES.md)', () => {
  it('passes the good fixture', () => {
    assert.deepEqual(checkAllowlist(goodSnapshot()), []);
  });

  it('requires DEPENDENCIES.md and its allowlist table', () => {
    assert.deepEqual(codes(checkAllowlist({ ...goodSnapshot(), dependenciesMd: null })), ['E_DEPENDENCIES_MD']);
    assert.deepEqual(codes(checkAllowlist({ ...goodSnapshot(), dependenciesMd: '# Dependencies\n' })), ['E_DEPENDENCIES_MD']);
  });

  it('refuses a package that is not listed, and a row with a different licence (compared with the installed package)', () => {
    const s = goodSnapshot();
    addDep(s, 'left-pad', 'left-pad@1.3.0');
    assert.deepEqual(codes(checkAllowlist(s)), ['E_NOT_ALLOWLISTED']);
    const t = goodSnapshot();
    t.dependenciesMd = (t.dependenciesMd as string).replace('| Apache-2.0 |', '| MIT |');
    assert.deepEqual(checkAllowlist(t), []);
    assert.deepEqual(codes(checkLicences(t, [installed('typescript', '6.0.3', 'Apache-2.0')]).findings), ['E_LICENCE_MISMATCH']);
  });

  it('expects "none declared" for a package without a licence', () => {
    const s = goodSnapshot();
    assert.deepEqual(codes(checkLicences(s, [installed('typescript', '6.0.3', null)]).findings), ['E_LICENCE_MISMATCH']);
    s.dependenciesMd = (s.dependenciesMd as string).replace('| Apache-2.0 |', '| none declared |');
    assert.deepEqual(checkLicences(s, [installed('typescript', '6.0.3', null)]).findings, []);
    assert.deepEqual(checkAllowlist(s), []);
  });

  it('requires purpose, licence and reviewer, and one row per package', () => {
    const s = goodSnapshot();
    s.dependenciesMd = (s.dependenciesMd as string).replace('| `typescript` | Type checker | Apache-2.0 | fixture |', '| `typescript` |  | Apache-2.0 | fixture |');
    assert.deepEqual(codes(checkAllowlist(s)), ['E_ALLOWLIST_ROW', 'E_NOT_ALLOWLISTED']);
    const t = goodSnapshot();
    t.dependenciesMd = (t.dependenciesMd as string).replace('| `typescript` |', '| `@solana/kit` | again | MIT | fixture |\n| `typescript` |');
    assert.deepEqual(codes(checkAllowlist(t)), ['E_ALLOWLIST_ROW']);
    const u = goodSnapshot();
    u.dependenciesMd = (u.dependenciesMd as string).replace('| `typescript` | Type checker | Apache-2.0 | fixture |', '|');
    assert.deepEqual(codes(checkAllowlist(u)), ['E_ALLOWLIST_ROW', 'E_NOT_ALLOWLISTED']);
  });

  it('refuses a row that names no reviewer: "pending", empty or a dash (C01 red-team m2)', () => {
    for (const cell of ['pending', 'Pending (supervisor)', '', '-', '—', '?']) {
      const s = goodSnapshot();
      s.dependenciesMd = (s.dependenciesMd as string).replace('| Apache-2.0 | fixture |', `| Apache-2.0 | ${cell} |`);
      const findings = checkAllowlist(s);
      assert.deepEqual(codes(findings), ['E_ALLOWLIST_REVIEWER'], cell);
      assert.match(findings[0]?.message ?? '', /^1 row\(s\) name no reviewer .*first at line 9;/);
    }
    assert.equal(isUnnamedReviewer('A. Reviewer'), false);
    assert.equal(isUnnamedReviewer('pendingly'), false);
  });

  it('needs rows for both the real package and the alias of an npm: alias install (C01 red-team M1)', () => {
    const s = goodSnapshot();
    addDep(s, '@solana/rpc-legacy', '@solana/web3.js@1.95.6');
    s.dependenciesMd = (s.dependenciesMd as string).replace('| `@solana/kit` |', '| `@solana/rpc-legacy` | Transitive | MIT | x |\n| `@solana/kit` |');
    const findings = checkAllowlist(s);
    assert.deepEqual(findings.map((f) => f.code), ['E_NOT_ALLOWLISTED']);
    assert.match(findings[0]?.message ?? '', /^@solana\/web3\.js \(@solana\/web3\.js@1\.95\.6\)/);
    s.dependenciesMd = (s.dependenciesMd as string).replace('| `@solana/kit` |', '| `@solana/web3.js` | Transitive | Apache-2.0 | x |\n| `@solana/kit` |');
    assert.deepEqual(checkAllowlist(s), []);
    const lic = checkLicences(s, [installed('@solana/web3.js', '1.95.6', 'MIT')]).findings;
    assert.deepEqual(lic.map((f) => f.message), ['@solana/web3.js: the allowlist says "Apache-2.0", the installed @solana/web3.js@1.95.6 declares "MIT"'],
      'each name is compared: the alias row (MIT) matches, the real package row does not');
  });

  it('treats a snapshot without a lockfile as listing no packages', () => {
    assert.deepEqual(checkAllowlist({ ...goodSnapshot(), lock: null }), []);
  });

  it('covers the packages of every workspace project outside Zeroed\'s paths; --include-zeroed covers those too', () => {
    const s = goodSnapshot();
    addDep(s, 'zeroed-only', 'zeroed-only@1.0.0', 'apps/web');
    assert.deepEqual(checkAllowlist(s), [], 'apps/ is a Zeroed path');
    assert.deepEqual(codes(checkAllowlist(s, scopeOf(true))), ['E_NOT_ALLOWLISTED']);
    addDep(s, 'new-only', 'new-only@1.0.0', 'packages/newpkg');
    assert.deepEqual(checkAllowlist(s).map((f) => f.message.split(' ')[0]), ['new-only'], 'a new workspace project is checked');
  });

  it('parses a table up to its end, the end of the file included', () => {
    assert.deepEqual(parseTable('| A | B |\n|---|---|\n| `x` | y |', ['a', 'b']), [{ cells: ['x', 'y'], line: 3 }]);
    assert.deepEqual(parseTable('| A |\n|---|\n| 1 |\ntext\n| 2 |', ['A']), [{ cells: ['1'], line: 3 }]);
    assert.equal(parseTable('| A | B |', ['A']), null);
    assert.equal(parseTable('A | B', ['A', 'B']), null);
  });
});

describe('typosquat and known-malicious packages (TH-37, TH-38, TH-40, TH-41)', () => {
  it('passes the good fixture, with or without a lockfile', () => {
    assert.deepEqual(checkTyposquats(goodSnapshot()), []);
    assert.deepEqual(checkTyposquats({ ...goodSnapshot(), lock: null }), []);
  });

  it('refuses known malicious names wherever they appear', () => {
    const s = goodSnapshot();
    (s.manifests[0] as { json: { dependencies?: Record<string, string> } }).json.dependencies = { 'raydium-bs58': '1.0.0' };
    assert.deepEqual(codes(checkTyposquats(s)), ['E_KNOWN_MALICIOUS']);
    const t = goodSnapshot();
    addPackage(t, 'crypto-layout-utils@1.0.0');
    assert.deepEqual(codes(checkTyposquats(t)), ['E_KNOWN_MALICIOUS']);
  });

  it('refuses compromised versions, not the package', () => {
    const s = goodSnapshot();
    addPackage(s, 'debug@4.4.2');
    assert.deepEqual(codes(checkTyposquats(s)), ['E_KNOWN_MALICIOUS']);
    const t = goodSnapshot();
    addPackage(t, 'debug@4.4.3');
    assert.deepEqual(checkTyposquats(t), []);
    const u = goodSnapshot();
    addPackage(u, 'debug');
    assert.deepEqual(checkTyposquats(u), [], 'an entry without a version');
  });

  it('refuses look-alikes of targeted names but not the genuine packages or the official scope', () => {
    const s = goodSnapshot();
    addPackage(s, 'bs58-check-pro@1.0.0');
    assert.deepEqual(codes(checkTyposquats(s)), ['E_TYPOSQUAT']);
    for (const name of ['bs58', 'base-x', 'async-mutex', 'ethers', '@solana/kit', '@solana/web3.js', 'typescript', 'ms', 'debug', '@bot/solana-rpc']) {
      assert.equal(lookalikeOf(name), null, name);
    }
    for (const [name, target] of [['bs85', 'bs58'], ['basex', 'base-x'], ['@raydium-io/raydium-sdk-v2', 'raydium'], ['dexscreener-api', 'dexscreener'],
      ['solana-utils', 'solana'], ['pumpfun-sdk', 'pumpfun'], ['asyncmutex', 'async-mutex'], ['ether', 'ethers'], ['web3js', 'web3.js']]) {
      assert.equal(lookalikeOf(name as string), target, name);
    }
  });

  it('checks the real package of an alias as well as the alias name (C01 red-team M1)', () => {
    const s = goodSnapshot();
    addDep(s, '@solana/rpc-legacy', '@solana/web3.js@1.95.6');
    assert.deepEqual(codes(checkTyposquats(s)), ['E_KNOWN_MALICIOUS']);
    const t = goodSnapshot();
    addDep(t, 'helper', 'helper-x@1.0.0');
    addDep(t, 'bs58-helper', 'helper-y@1.0.0');
    assert.deepEqual(checkTyposquats(t).map((f) => f.message.split(' ')[0]), ['bs58-helper']);
    const u = goodSnapshot();
    (u.manifests[0] as { json: { dependencies?: Record<string, string> } }).json.dependencies = { helper: 'npm:raydium-bs58@1.0.0', same: 'npm:same@1.0.0' };
    assert.deepEqual(codes(checkTyposquats(u)), ['E_KNOWN_MALICIOUS']);
  });

  it('measures edit distance and normalises names', () => {
    assert.equal(editDistance('kitten', 'sitting'), 3);
    assert.equal(editDistance('', 'abc'), 3);
    assert.equal(editDistance('abc', 'abc'), 0);
    assert.equal(normalise('@Solana/Web3.js'), 'solanaweb3js');
  });
});

describe('workflows', () => {
  const CI = '.github/workflows/ci.yml';
  const GUARD = '.github/workflows/guard.yml';
  const SCHEDULE = AUDIT_SCHEDULE_WORKFLOW;
  const good = goodSnapshot().workflows.find((w) => w.file === CI)?.text as string;
  const guard = goodSnapshot().workflows.find((w) => w.file === GUARD)?.text as string;
  const schedule = goodSnapshot().workflows.find((w) => w.file === SCHEDULE)?.text as string;
  const ci = (text: string, guardText: string = guard, scheduleText: string = schedule): RepoSnapshot =>
    ({ ...goodSnapshot(), workflows: [{ file: CI, text }, { file: GUARD, text: guardText }, { file: SCHEDULE, text: scheduleText }] });
  const real = readdirSync(join(REPO_ROOT, '.github/workflows')).sort()
    .map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(REPO_ROOT, '.github/workflows', f), 'utf8') }));
  const realCi = real.find((w) => w.file === CI)?.text as string;
  const step = (body: string): string => `${good}${body}`;

  it('passes the good fixture and this repository, comments included', () => {
    assert.deepEqual(checkWorkflows(goodSnapshot()), []);
    assert.deepEqual(checkWorkflows({ ...goodSnapshot(), workflows: real }), []);
    assert.ok([CI, SCHEDULE, '.github/workflows/sbom.yml'].every((f) => real.some((w) => w.file === f)));
    // Supervisor ruling 2 (round 1 review F2): the guard is not in this repository. A pull_request_target run reports
    // against the base branch's newest commit, so a failed guard run would stop every deploy from that commit on.
    assert.equal(real.some((w) => w.file === GUARD), false, 'guard.yml is a follow-up card, not this PR');
    assert.deepEqual(checkWorkflows(ci(step('      # - uses: actions/x@v1\n      - run: echo done # comment\n'))), []);
  });

  it('skips Zeroed\'s workflows and jobs; --include-zeroed reads them', () => {
    const zeroed = checkWorkflows({ ...goodSnapshot(), workflows: real }, scopeOf(true));
    assert.ok(zeroed.length > 0, 'Zeroed\'s workflows use secrets and pnpm commands the policy refuses');
    assert.ok(zeroed.every((f) => ![SCHEDULE, '.github/workflows/sbom.yml'].some((ok) => f.file.startsWith(ok))), 'only Zeroed\'s files and jobs');
    assert.ok(zeroed.some((f) => f.file.startsWith(`${CI} jobs.historical-data`)), 'the historical-data job writes GITHUB_PATH');
    const extra = `${good}  historical-data:\n    runs-on: x\n    steps:\n      - run: echo /x >> "$GITHUB_PATH"\n`;
    assert.deepEqual(checkWorkflows(ci(extra)), []);
    assert.deepEqual(codes(checkWorkflows(ci(extra), scopeOf(true))), ['E_WORKFLOW_COMMAND']);
    assert.deepEqual(codes(checkWorkflows(ci(extra.replace('historical-data', 'new-job')))), ['E_WORKFLOW_COMMAND'], 'any other job is checked');
  });

  it('requires every action and reusable workflow pinned by a full commit SHA', () => {
    for (const ref of ['actions/checkout@v7', 'actions/checkout@main', 'actions/checkout@3d3c42e', 'docker://alpine:3', '"actions/checkout@v7"']) {
      assert.deepEqual(codes(checkWorkflows(ci(step(`      - uses: ${ref}\n`)))), ['E_ACTION_NOT_PINNED'], ref);
    }
    assert.deepEqual(codes(checkWorkflows(ci(`${good}  reuse:\n    uses: o/r/.github/workflows/x.yml@v1\n`))), ['E_ACTION_NOT_PINNED']);
  });

  it('allows pnpm only as install --frozen-lockfile, lint, typecheck, test and -r, and no other package runner (C01 red-team m1)', () => {
    for (const cmd of ['pnpm install', 'pnpm install --no-frozen-lockfile', 'pnpm install --frozen-lockfile --no-frozen-lockfile', 'pnpm install --frozen-lockfile=false']) {
      assert.deepEqual(codes(checkWorkflows(ci(step(`      - run: ${cmd}\n`)))), ['E_LOCK_NOT_FROZEN'], cmd);
    }
    for (const cmd of ['pnpm install --frozen-lockfile --ignore-scripts=false', 'pnpm install --frozen-lockfile --no-ignore-scripts', 'pnpm -r --ignore-scripts false build']) {
      assert.deepEqual(codes(checkWorkflows(ci(step(`      - run: ${cmd}\n`)))), ['E_INSTALL_SCRIPTS_ENABLED'], cmd);
    }
    for (const cmd of ['pnpm i', 'pnpm add left-pad', 'pnpm rebuild', 'pnpm exec x', 'pnpm dlx y', 'pnpm audit', 'pnpm update', 'pnpm approve-builds',
      'pnpm --silent install --frozen-lockfile', 'pnpm', 'echo ok && pnpm up', 'pnpm install --frozen-lockfile --config.dangerously-allow-all-builds=true',
      'npx tsc', 'npm ci --ignore-scripts', 'npm test', 'pnpx x', 'yarn', 'bun install', 'bunx x', 'corepack enable', 'x=$(npx y)']) {
      assert.deepEqual(codes(checkWorkflows(ci(step(`      - run: ${cmd}\n`)))), ['E_WORKFLOW_COMMAND'], cmd);
    }
    for (const cmd of ['pnpm install --frozen-lockfile && pnpm test', 'pnpm -r --if-present build', 'pnpm lint', 'echo pnpmish npmrc']) {
      assert.deepEqual(checkWorkflows(ci(step(`      - run: ${cmd}\n`))), [], cmd);
    }
    const findings: Finding[] = [];
    checkRun('w', 'pnpm install --frozen-lockfile\npnpm install\n', findings);
    assert.deepEqual(findings.map((f) => f.code), ['E_LOCK_NOT_FROZEN']);
  });

  it('refuses secrets and write permissions, and requires a read-only permissions block', () => {
    for (const line of ['      - run: echo ${{ secrets.KEY }}', '      - if: secrets.KEY != \'\'\n        run: echo', '    secrets: inherit']) {
      assert.ok(codes(checkWorkflows(ci(`${good}${line}\n`))).includes('E_WORKFLOW_SECRETS'), line);
    }
    assert.deepEqual(codes(checkWorkflows(ci(good.replace('contents: read', 'contents: write')))), ['E_WORKFLOW_PERMISSIONS']);
    assert.deepEqual(codes(checkWorkflows(ci(good.replace('permissions:\n  contents: read\n', '')))), ['E_WORKFLOW_PERMISSIONS']);
    assert.deepEqual(codes(checkWorkflows(ci(good.replace('permissions:\n  contents: read\n', 'permissions: write-all\n')))), ['E_WORKFLOW_PERMISSIONS']);
    assert.deepEqual(checkWorkflows(ci(good.replace('permissions:\n  contents: read\n', 'permissions: read-all\n'))), []);
    assert.deepEqual(checkWorkflows(ci(good.replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-24.04\n    permissions:\n      contents: none'))), []);
    assert.deepEqual(codes(checkWorkflows(ci(good.replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-24.04\n    permissions:\n      issues: wrote')))), ['E_WORKFLOW_PERMISSIONS']);
  });

  it('requires the event variables the drift and audit steps read (supervisor rulings 1 and 7)', () => {
    const drop = (from: string): string[] => {
      assert.ok(realCi.includes(from), from);
      return codes(checkWorkflows(ci(realCi.replace(from, ''))));
    };
    // Without POLICY_EVENT the audit would fail a push on an advisory for a version already in use, which stops the
    // deploy gate; without PR_LABELS or PR_LABEL_ADDED the review-label check would see no label.
    assert.deepEqual(drop("          POLICY_EVENT: ${{ github.event_name }}\n"), ['E_CI_STEP_ENV']);
    assert.deepEqual(drop("          PR_LABELS: ${{ join(github.event.pull_request.labels.*.name, ',') }}\n"), ['E_CI_STEP_ENV']);
    assert.deepEqual(drop("          PR_LABEL_ADDED: ${{ github.event.action == 'labeled' && github.event.label.name || '' }}\n"), ['E_CI_STEP_ENV']);
    const wrong = realCi.replace('POLICY_EVENT: ${{ github.event_name }}', "POLICY_EVENT: push");
    assert.deepEqual(codes(checkWorkflows(ci(wrong))), ['E_CI_STEP_ENV', 'E_WORKFLOW_ENV'], 'and only its reviewed value');
    assert.deepEqual(codes(checkWorkflows(ci(realCi))), [], 'this repository passes');
  });

  it('requires the scheduled advisory report, on a schedule only, with every step continue-on-error (supervisor ruling 1)', () => {
    assert.deepEqual(checkWorkflows(ci(good)), [], 'the fixture report passes');
    const missing = checkWorkflows({ ...goodSnapshot(), workflows: [{ file: CI, text: good }, { file: GUARD, text: guard }] });
    assert.deepEqual(codes(missing), ['E_AUDIT_SCHEDULE']);
    assert.match(missing[0]?.message ?? '', /the scheduled advisory report is missing/);
    const bad = (from: string, to: string): string[] => { assert.ok(schedule.includes(from), from); return codes(checkWorkflows(ci(good, guard, schedule.replace(from, to)))); };
    assert.deepEqual(bad('on:\n  schedule:', 'on:\n  pull_request:\n  schedule:'), ['E_AUDIT_SCHEDULE'], 'no pull request may start it');
    assert.deepEqual(bad('  schedule:\n    - cron: "41 6 * * *"\n', '  push:\n'), ['E_AUDIT_SCHEDULE'], 'it must run on a schedule');
    for (const [from, to] of [['        continue-on-error: true\n        with:\n          persist-credentials: false\n', '        with:\n          persist-credentials: false\n'],
      ['      - continue-on-error: true\n        shell: bash\n        env:\n          GH_TOKEN: ${{ github.token }}\n', '      - shell: bash\n        env:\n          GH_TOKEN: ${{ github.token }}\n'],
      ['      - continue-on-error: true\n        shell: bash\n        env:\n          POLICY_EVENT', '      - shell: bash\n        env:\n          POLICY_EVENT']] as const) {
      assert.deepEqual(bad(from, to), ['E_AUDIT_SCHEDULE'], 'a step that can fail would put a red run on the default branch\'s newest commit');
    }
    assert.deepEqual(bad('    - cron: "41 6 * * *"', '    - cron: "41 6 * * 1"'), [], 'the cron itself is not fixed');
  });

  it('names the report\'s one job zeroed-advisories, a name no other workflow may use, Zeroed\'s included (ruling 3.4)', () => {
    assert.deepEqual(checkWorkflows(ci(good)), []);
    const job = '  zeroed-advisories:\n';
    assert.ok(schedule.includes(job));
    assert.deepEqual(codes(checkWorkflows(ci(good, guard, schedule.replace(job, '  advisories:\n')))), ['E_AUDIT_JOB_NAME'], 'renamed: the gate would count it again');
    assert.deepEqual(codes(checkWorkflows(ci(good, guard, schedule.replace(job, `${job}    name: other\n`)))), ['E_AUDIT_JOB_NAME'], 'a display name changes the check run name');
    assert.deepEqual(codes(checkWorkflows(ci(good, guard, `${schedule}  second:\n    runs-on: x\n    steps:\n      - continue-on-error: true\n        run: echo\n`))), ['E_AUDIT_JOB_NAME']);
    const borrow = (text: string, file = '.github/workflows/other.yml'): string[] =>
      codes(checkWorkflows({ ...ci(good), workflows: [...ci(good).workflows, { file, text }] }));
    const other = 'name: other\non: [push]\npermissions:\n  contents: read\njobs:\n  zeroed-advisories:\n    runs-on: x\n    steps:\n      - run: exit 1\n';
    assert.deepEqual(borrow(other), ['E_AUDIT_JOB_NAME'], 'a failing job hiding under the ignored name');
    assert.deepEqual(borrow(other.replace('  zeroed-advisories:\n', '  x:\n    name: zeroed-advisories\n')), ['E_AUDIT_JOB_NAME'], 'by display name');
    assert.deepEqual(borrow(other, '.github/workflows/deploy.yml'), ['E_AUDIT_JOB_NAME'], 'Zeroed\'s workflows too');
    assert.deepEqual(codes(checkWorkflows(ci(good.replace('  check:\n', '  check:\n    name: zeroed-advisories\n')))), ['E_AUDIT_JOB_NAME'], 'ci.yml may not borrow it');
    // The deploy gate ignores the same name the policy reserves.
    const logic = readFileSync(join(REPO_ROOT, 'ops/host/files/usr/local/lib/zeroed/logic.sh'), 'utf8');
    assert.ok(logic.includes(`DEPLOY_AUDIT_JOB=${AUDIT_JOB}\n`), 'logic.sh DEPLOY_AUDIT_JOB');
  });

  it('refuses an expression in any job name, in every workflow, Zeroed\'s included (RT3-03, M1, ruling 5.3)', () => {
    const other = (job: string): string => `name: other\non: [push]\npermissions:\n  contents: read\njobs:\n  x:\n${job}    runs-on: x\n    steps:\n      - run: exit 1\n`;
    const borrow = (text: string, file = '.github/workflows/other.yml'): string[] =>
      codes(checkWorkflows({ ...ci(good), workflows: [...ci(good).workflows, { file, text }] }));
    assert.deepEqual(borrow(other("    name: ${{ format('zeroed-{0}', 'advisories') }}\n")), ['E_JOB_NAME_EXPR'], 'the red team\'s computed name');
    assert.deepEqual(borrow(other("    name: build-${{ matrix.os }}\n")), ['E_JOB_NAME_EXPR'], 'any expression');
    assert.deepEqual(borrow(other("    name: ${{ format('zeroed-{0}', 'advisories') }}\n"), '.github/workflows/deploy.yml'), ['E_JOB_NAME_EXPR'], 'Zeroed\'s workflows too');
    assert.deepEqual(borrow(other('    name: plain\n')), [], 'a plain name');
    assert.deepEqual(borrow(other('').replace('      - run: exit 1\n', '      - name: step-${{ matrix.os }}\n        run: exit 1\n')), [], 'a step name is not a check run');
    const unparsable = `name: x\non: {push: {}}\njobs:\n  a:\n    name: zeroed-${'${{'} 'advisories' }}\n    runs-on: x\n`;
    assert.deepEqual(borrow(unparsable, '.github/workflows/backtest-trial.yml'), ['E_JOB_NAME_EXPR'], 'a workflow the reader cannot follow is searched as text');
    assert.deepEqual(borrow(unparsable.replace("zeroed-${{ 'advisories' }}", 'plain'), '.github/workflows/backtest-trial.yml'), []);
  });

  it('refuses YAML anchors and aliases in every workflow, Zeroed\'s included (ruling 6.3)', () => {
    const other = 'name: other\non: [push]\npermissions:\n  contents: read\njobs:\n  x:\n    runs-on: x\n    steps:\n      - run: exit 1\n';
    const borrow = (text: string, file = '.github/workflows/other.yml'): string[] =>
      checkWorkflows({ ...ci(good), workflows: [...ci(good).workflows, { file, text }] }).map((f) => `${f.code} ${f.file}`);
    // The policy's YAML reader also stops at an anchor (E_WORKFLOW_PARSE); E_YAML_ANCHOR names the line and holds
    // whatever the reader does.
    const anchors = (text: string, file?: string): string[] => borrow(text, file).filter((f) => f.startsWith('E_YAML_ANCHOR'));
    assert.deepEqual(borrow(`x-env: &env\n  A: 1\n${other}`), ['E_WORKFLOW_PARSE .github/workflows/other.yml', 'E_YAML_ANCHOR .github/workflows/other.yml:1'], 'an anchor');
    assert.deepEqual(anchors(other.replace('    runs-on: x\n', '    runs-on: x\n    env: *env\n')), ['E_YAML_ANCHOR .github/workflows/other.yml:8'], 'an alias');
    assert.deepEqual(anchors(other.replace('    runs-on: x\n', '    runs-on: x\n    <<: *base\n')), ['E_YAML_ANCHOR .github/workflows/other.yml:8'],
      'a merge key and its alias');
    assert.deepEqual(yamlAnchors('  <<: {a: 1}\n'), [{ line: 1, token: '<<' }], 'a merge key alone');
    assert.deepEqual(anchors(`x-env: &env\n  A: 1\n${other}`, '.github/workflows/deploy.yml'), ['E_YAML_ANCHOR .github/workflows/deploy.yml:1'], 'Zeroed\'s workflows too');
    // Not anchors: a glob in a run block, a quoted value, a comment, and & or * inside a word.
    assert.deepEqual(borrow(other.replace('      - run: exit 1\n', '      - run: |\n          ls *.ts && echo &x\n      - run: echo "*not"\n        # &comment\n        name: a&b *c\n')), []);
    assert.deepEqual(yamlAnchors('a: &x 1\nb: *x\n- *y\nc: [*z]\n'), [{ line: 1, token: '&x' }, { line: 2, token: '*x' }, { line: 3, token: '*y' }, { line: 4, token: '*z' }]);
    for (const w of ci(good).workflows) assert.deepEqual(yamlAnchors(w.text), [], `${w.file} has none`);
  });

  it('runs a label event in a concurrency group of its own, so nothing cancels the labeled run (ruling 3.3)', () => {
    assert.ok(CI_CONCURRENCY_GROUP.includes('github.event.action') && CI_CONCURRENCY_GROUP.includes('github.event.label.name'));
    assert.ok(realCi.includes(`  group: ${CI_CONCURRENCY_GROUP}\n`), 'this repository\'s ci.yml');
    assert.deepEqual(checkWorkflows(ci(realCi)), []);
    const old = "ci-${{ github.event.pull_request.number && format('pr-{0}', github.event.pull_request.number) || github.run_id }}";
    assert.deepEqual(codes(checkWorkflows(ci(realCi.replace(CI_CONCURRENCY_GROUP, old)))), ['E_CI_CONCURRENCY'], 'the round 2 group let a label event cancel the labeled run');
    assert.deepEqual(codes(checkWorkflows(ci(realCi.replace(`  group: ${CI_CONCURRENCY_GROUP}\n`, '')))), ['E_CI_CONCURRENCY']);
  });

  it('allows "issues: write" in the scheduled report only, and no other write anywhere (supervisor ruling 1)', () => {
    assert.ok(schedule.includes('  issues: write\n'), 'the report declares it');
    assert.deepEqual(checkWorkflows(ci(good)), []);
    for (const write of ['  packages: write\n', '  pull-requests: write\n', '  issues: write\n  actions: write\n']) {
      assert.deepEqual(codes(checkWorkflows(ci(good, guard, schedule.replace('  issues: write\n', write)))), ['E_WORKFLOW_PERMISSIONS'], write);
    }
    assert.deepEqual(codes(checkWorkflows(ci(schedule.replace('name: audit-schedule', 'name: ci')))), ['E_AUDIT_JOB_NAME', 'E_CI_CONCURRENCY', 'E_WORKFLOW_PERMISSIONS', 'E_CI_JOB_NAME', 'E_CI_STEP_MISSING', 'E_WORKFLOW_TRIGGER'].sort(),
      'the same permission in another workflow is refused');
    assert.deepEqual(codes(checkWorkflows(ci(good, guard, schedule.replace('    runs-on: ubuntu-24.04', '    runs-on: ubuntu-24.04\n    permissions:\n      issues: write')))), [],
      'the job may narrow to the same scope');
    assert.deepEqual(codes(checkWorkflows(ci(good, guard, schedule.replace('    runs-on: ubuntu-24.04', '    runs-on: ubuntu-24.04\n    permissions:\n      packages: write')))), ['E_WORKFLOW_PERMISSIONS']);
  });

  it('refuses pull_request_target and workflow_run outside the guard (C01 red-team m1)', () => {
    for (const on of ['on: [pull_request_target]', 'on: workflow_run', 'on:\n  pull_request_target:\n    types: [opened]']) {
      assert.deepEqual(codes(checkWorkflows(ci(good.replace('on: [pull_request]', on)))), ['E_WORKFLOW_TRIGGER'], on);
    }
    assert.deepEqual(triggers(null), []);
    assert.deepEqual(triggers(['push', ['x']]), ['push']);
    assert.deepEqual(triggers({ push: null, pull_request: null }), ['push', 'pull_request']);
  });

  it('refuses defaults and new values for the variables that steer the policy tools, Node, pnpm and npm', () => {
    assert.deepEqual(codes(checkWorkflows(ci(good.replace('jobs:', 'defaults:\n  run:\n    working-directory: x\njobs:')))), ['E_WORKFLOW_DEFAULTS']);
    assert.deepEqual(codes(checkWorkflows(ci(good.replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-24.04\n    defaults:\n      run:\n        shell: sh')))), ['E_WORKFLOW_DEFAULTS']);
    for (const env of ['POLICY_BASE_REF: HEAD', 'PR_LABELS: deps-reviewed:0123', 'NODE_OPTIONS: --require ./x.js', 'npm_config_ignore_scripts: "false"', 'PATH: ./bin', 'BASH_ENV: ./x.sh',
      'PNPM_HOME: ./x', 'pnpm_config_ignore_scripts: "false"', 'COREPACK_ENABLE_STRICT: "0"']) {
      assert.deepEqual(codes(checkWorkflows(ci(good.replace('jobs:', `env:\n  ${env}\njobs:`)))), ['E_WORKFLOW_ENV'], env);
      assert.deepEqual(codes(checkWorkflows(ci(good.replace('runs-on: ubuntu-24.04', `runs-on: ubuntu-24.04\n    env:\n      ${env}`)))), ['E_WORKFLOW_ENV'], env);
      assert.deepEqual(codes(checkWorkflows(ci(good.replace('      - run: pnpm lint', `      - env:\n          ${env}\n        run: pnpm lint`)))), ['E_WORKFLOW_ENV'], env);
    }
    assert.deepEqual(checkWorkflows(ci(good.replace('jobs:', 'env:\n  OTHER: x\n  PR_LABELS: ${{ join(github.event.pull_request.labels.*.name, \',\') }}\njobs:'))), []);
    assert.deepEqual(checkWorkflows(ci(good.replace('jobs:', 'env:\n  POLICY_BASE_REF: ${{ format(\'origin/{0}\', github.base_ref || github.ref_name) }}\njobs:'))), []);
  });

  it('requires each CI step as its own unconditional step, in order, in the job named check (C01 red-team m1)', () => {
    assert.deepEqual(codes(checkWorkflows({ ...goodSnapshot(), workflows: [{ file: GUARD, text: guard }] })), ['E_AUDIT_SCHEDULE', 'E_CI_MISSING']);
    const missing = checkWorkflows(ci(good.replace('      - env:\n          POLICY_EVENT: ${{ github.event_name }}\n        run: node tools/policy/bin/audit.ts\n', '')));
    assert.deepEqual(missing.map((f) => f.message), ['the CI workflow must run "node tools/policy/bin/audit.ts" as its own step']);
    const disable = (from: string, to: string): string[] => {
      assert.ok(realCi.includes(from), from);
      return codes(checkWorkflows(ci(realCi.replace(from, to))));
    };
    const audit = '      - name: Audit (packages of the checked workspace projects)\n';
    assert.deepEqual(disable('      - name: Lockfile and policy', '      - if: false\n        name: Lockfile and policy'), ['E_CI_STEP_DISABLED']);
    assert.deepEqual(disable(audit, `${audit}        continue-on-error: true\n`), ['E_CI_STEP_DISABLED']);
    assert.deepEqual(disable(audit, `${audit}        working-directory: tools/policy/test/fixtures/good\n`), ['E_CI_STEP_DISABLED']);
    assert.deepEqual(disable(audit, `${audit}        shell: sh\n`), ['E_CI_STEP_DISABLED']);
    assert.deepEqual(disable('        shell: bash\n        run: pnpm test', '        run: pnpm test'), ['E_CI_STEP_DISABLED']);
    assert.deepEqual(disable('    timeout-minutes: 45\n', '    timeout-minutes: 45\n    continue-on-error: true\n'), ['E_CI_STEP_DISABLED']);
    assert.deepEqual(disable(`    if: ${CI_JOB_IF}\n`, '    if: false\n'), ['E_CI_STEP_DISABLED'], 'only the draft skip');
    assert.deepEqual(disable(`    if: ${CI_JOB_IF}\n`, ''), [], 'no condition at all');
    assert.deepEqual(disable('  check:\n', '  verify:\n'), ['E_CI_JOB_NAME'], 'the deploy gate counts only the job named check');
    // a changed required step is missing, and runs as an extra step before the last required one
    assert.deepEqual(disable('run: node tools/policy/bin/audit.ts', 'run: node tools/policy/bin/audit.ts || true'), ['E_CI_STEP_EXTRA', 'E_CI_STEP_MISSING']);
    assert.deepEqual(disable('run: node tools/policy/bin/audit.ts', 'run: |\n          echo skipped\n          node tools/policy/bin/audit.ts'), ['E_CI_STEP_EXTRA', 'E_CI_STEP_MISSING']);
    assert.deepEqual(disable('run: node tools/policy/bin/audit.ts', 'run: echo node tools/policy/bin/audit.ts'), ['E_CI_STEP_EXTRA', 'E_CI_STEP_MISSING']);
    const swapped = realCi.replace('run: pnpm lint', 'run: TMP').replace('run: pnpm typecheck', 'run: pnpm lint').replace('run: TMP', 'run: pnpm typecheck');
    assert.deepEqual(codes(checkWorkflows(ci(swapped))), ['E_CI_STEP_ORDER']);
    assert.deepEqual(codes(checkWorkflows(ci('name: x\non: [pull_request]\npermissions:\n  contents: read\n'))), ['E_CI_CONCURRENCY', 'E_CI_JOB_NAME', 'E_CI_STEP_MISSING'], 'no jobs at all');
    assert.deepEqual(checkWorkflows(ci(step('      - just a string step\n'))), [], 'a step that is not a mapping runs nothing');
    const split = `${good}  other:\n    runs-on: x\n    steps:\n      - run: pnpm lint\n`;
    assert.deepEqual(checkWorkflows(ci(split)), [], 'the job with the most required steps is the one checked');
  });

  it('refuses local actions, environment-file writes and new runner variables (C01 review R6)', () => {
    assert.deepEqual(codes(checkWorkflows(ci(step('      - uses: ./.github/actions/local\n')))), ['E_ACTION_NOT_PINNED']);
    assert.deepEqual(codes(checkWorkflows(ci(`${good}  reuse:\n    uses: ./.github/workflows/x.yml\n`))), ['E_ACTION_NOT_PINNED']);
    for (const cmd of ['echo "NPM_CONFIG_IGNORE_SCRIPTS=false" >> "$GITHUB_ENV"', 'echo "$PWD/bin" >> $GITHUB_PATH', 'echo x > ${{ env.GITHUB_ENV }}',
      'cat x >> /home/runner/work/_temp/_runner_file_commands/set_env_1', 'echo "::set-env name=X::y"', 'echo "::add-path::/tmp"']) {
      assert.deepEqual(codes(checkWorkflows(ci(step(`      - run: ${JSON.stringify(cmd)}\n`)))), ['E_WORKFLOW_COMMAND'], cmd);
    }
    for (const env of ['ESLINT_FLAGS: x', 'ACTIONS_ALLOW_UNSECURE_COMMANDS: "true"', 'GITHUB_ENV: /tmp/x']) {
      assert.deepEqual(codes(checkWorkflows(ci(good.replace('jobs:', `env:\n  ${env}\njobs:`)))), ['E_WORKFLOW_ENV'], env);
    }
  });

  it('runs CI on every pull request: no branch, tag or path filter (C01 review R6)', () => {
    const on = (trigger: string): string[] => codes(checkWorkflows(ci(good.replace('on: [pull_request]', trigger))));
    assert.deepEqual(on(`on:\n  pull_request:\n    types: [opened, synchronize, reopened, labeled, unlabeled, ready_for_review]\n  push:\n    branches: [main, ${INTEGRATION_BRANCH}]\n    tags: ['v*']`), []);
    assert.deepEqual(on('on:\n  pull_request:\n  push:'), []);
    for (const bad of ['on:\n  pull_request:\n    paths: [none]', 'on:\n  pull_request:\n    branches: [nothing]', 'on:\n  pull_request:\n    paths-ignore: [\'**\']',
      'on:\n  pull_request:\n    types: [labeled]', 'on:\n  pull_request:\n    types: [opened, synchronize, reopened]', 'on:\n  pull_request:\n    types: opened', 'on: [push]',
      `on:\n  push:\n    branches: [${INTEGRATION_BRANCH}]`, 'on:\n  pull_request:\n  push:\n    paths: [x]', 'on:\n  pull_request:\n  push:\n    branches: [main]',
      `on:\n  pull_request:\n  push:\n    branches: ${INTEGRATION_BRANCH}`]) {
      assert.deepEqual(on(bad), ['E_WORKFLOW_TRIGGER'], bad);
    }
  });

  it('runs nothing in the CI job before its last required step but the required steps, checkout, pnpm/action-setup and setup-node (C01 review R6)', () => {
    const before = (text: string): string[] => codes(checkWorkflows(ci(good.replace('      - run: pnpm install --frozen-lockfile\n', `${text}      - run: pnpm install --frozen-lockfile\n`))));
    const between = (text: string): string[] => codes(checkWorkflows(ci(good.replace('      - run: pnpm lint\n', `${text}      - run: pnpm lint\n`))));
    const pin = '0000000000000000000000000000000000000002';
    assert.deepEqual(before(`      - uses: actions/setup-node@${pin}\n        with:\n          node-version-file: .node-version\n`), []);
    assert.deepEqual(before(`      - name: again\n        uses: actions/checkout@${pin}\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n`), []);
    assert.deepEqual(before(`      - name: pnpm\n        uses: pnpm/action-setup@${pin}\n`), []);
    for (const text of [
      '      - run: echo "process.exit(0)" > tools/policy/bin/check.ts\n',
      `      - uses: actions/checkout@${pin}\n        with:\n          ref: main\n          persist-credentials: false\n`,
      `      - uses: actions/checkout@${pin}\n        with:\n          repository: someone/else\n          persist-credentials: false\n`,
      `      - uses: actions/checkout@${pin}\n`,
      `      - uses: actions/setup-node@${pin}\n        with:\n          node-version: 18\n`,
      `      - uses: actions/setup-node@${pin}\n        with:\n          node-version-file: .node-version\n          cache: pnpm\n`,
      `      - uses: actions/setup-node@${pin}\n        with:\n          node-version-file: .node-version\n        env:\n          X: y\n`,
      `      - uses: pnpm/action-setup@${pin}\n        with:\n          run_install: true\n`,
      `      - uses: pnpm/action-setup@${pin}\n        with:\n          version: 9\n`,
      `      - uses: actions/cache@${pin}\n`,
    ]) {
      assert.deepEqual(between(text), ['E_CI_STEP_EXTRA'], text);
    }
    for (const key of ['container: node:22', 'services:\n      x:\n        image: y']) {
      assert.deepEqual(codes(checkWorkflows(ci(good.replace('runs-on: ubuntu-24.04', `runs-on: ubuntu-24.04\n    ${key}`)))), ['E_CI_STEP_DISABLED'], key);
    }
  });

  it('fails closed on a workflow the reader cannot follow', () => {
    assert.deepEqual(codes(checkWorkflows(ci(`${good}x: &anchor y\n`))), ['E_WORKFLOW_PARSE', 'E_YAML_ANCHOR'], 'round 6: the anchor is named too (ruling 6.3)');
    assert.deepEqual(codes(checkWorkflows(ci('- a\n'))), ['E_WORKFLOW_PARSE']);
    assert.deepEqual(codes(checkWorkflows(ci(good, '- a\n'))), ['E_WORKFLOW_PARSE']);
    assert.deepEqual(codes(checkWorkflows(ci(`${good}      - with: {a: b}\n`))), ['E_WORKFLOW_PARSE'], 'flow mappings are read only in pnpm files');
  });

  it('keeps the guard to the base branch\'s drift check on pull_request_target, the pull request as data (C01 red-team M3)', () => {
    // The guard is optional in the repository (supervisor ruling 2); these rules hold for the file the follow-up card
    // brings back, and the fixture carries one so they are tested.
    assert.deepEqual(codes(checkWorkflows({ ...goodSnapshot(), workflows: [{ file: CI, text: good }, { file: SCHEDULE, text: schedule }] })), []);
    const bad = (from: string, to: string): string[] => { assert.ok(guard.includes(from), from); return codes(checkWorkflows(ci(good, guard.replace(from, to)))); };
    assert.deepEqual(bad('  pull_request_target:', '  pull_request:'), ['E_GUARD']);
    assert.deepEqual(bad('on:\n', 'on:\n  push:\n'), ['E_GUARD']);
    assert.deepEqual(bad('          path: pr\n', '          path: base\n'), ['E_GUARD']);
    assert.deepEqual(bad('          path: base\n          persist-credentials: false\n', '          path: base\n'), ['E_GUARD']);
    assert.deepEqual(bad('node-version-file: base/.node-version', 'node-version-file: pr/.node-version'), ['E_GUARD']);
    assert.deepEqual(bad('node-version-file: base/.node-version', 'node-version-file: base/.node-version\n          cache: pnpm'), ['E_GUARD']);
    assert.deepEqual(bad('node-version-file: base/.node-version', 'node-version-file: base/.node-version\n          package-manager-cache: true'), ['E_GUARD']);
    assert.deepEqual(bad('          node-version-file: base/.node-version\n', ''), ['E_GUARD']);
    assert.deepEqual(bad('      - working-directory: pr\n', '      - working-directory: pr\n        if: false\n'), ['E_GUARD']);
    assert.deepEqual(bad('      - working-directory: pr\n', '      - working-directory: base\n'), ['E_GUARD']);
    assert.deepEqual(bad('      - working-directory: pr\n', '      - working-directory: pr\n        shell: sh\n'), ['E_GUARD']);
    assert.deepEqual(bad('      - working-directory: pr\n', '      - working-directory: pr\n        continue-on-error: true\n'), ['E_GUARD']);
    assert.deepEqual(bad('run: node ../base/tools/policy/bin/drift.ts', 'run: node tools/policy/bin/drift.ts'), ['E_GUARD']);
    assert.deepEqual(bad('      - working-directory: pr\n        run: node ../base/tools/policy/bin/drift.ts\n', ''), ['E_GUARD']);
    assert.deepEqual(bad('      - working-directory: pr\n', '      - run: pnpm install --frozen-lockfile\n        working-directory: pr\n      - working-directory: pr\n'), ['E_GUARD']);
    assert.deepEqual(bad('      - working-directory: pr\n', '      - uses: actions/cache@0000000000000000000000000000000000000003\n      - working-directory: pr\n'), ['E_GUARD']);
  });

  it('pins the guard\'s checkouts input by input and runs it on every pull request without a condition (C01 review R6)', () => {
    const bad = (from: string, to: string): string[] => { assert.ok(guard.includes(from), from); return codes(checkWorkflows(ci(good, guard.replace(from, to)))); };
    assert.deepEqual(bad('          path: base\n', '          path: base\n          repository: someone/else\n'), ['E_GUARD']);
    assert.deepEqual(bad('          path: base\n', '          path: base\n          ref: refs/heads/old\n'), ['E_GUARD']);
    assert.deepEqual(bad('          path: pr\n', '          path: pr\n          repository: someone/else\n'), ['E_GUARD']);
    assert.deepEqual(bad('ref: refs/pull/${{ github.event.pull_request.number }}/merge', 'ref: main'), ['E_GUARD']);
    assert.deepEqual(bad('node-version-file: base/.node-version', 'node-version-file: base/other'), ['E_GUARD']);
    assert.deepEqual(bad('      - uses: actions/setup-node', '      - if: false\n        uses: actions/setup-node'), ['E_GUARD']);
    for (const key of ['if: false', 'continue-on-error: true', 'container: node:22']) {
      assert.deepEqual(bad('    runs-on: ubuntu-24.04\n', `    runs-on: ubuntu-24.04\n    ${key}\n`), ['E_CI_STEP_DISABLED'], key);
    }
    assert.deepEqual(bad('    types: [opened, synchronize, reopened, labeled, unlabeled]', '    types: [opened, synchronize, reopened, labeled, unlabeled]\n    branches: [none]'), ['E_WORKFLOW_TRIGGER']);
    assert.deepEqual(bad('    types: [opened, synchronize, reopened, labeled, unlabeled]', '    types: [labeled]'), ['E_WORKFLOW_TRIGGER']);
  });
});

describe('lint configuration (C01 review R1)', () => {
  const withLint = (lint: string | undefined): RepoSnapshot => {
    const s = goodSnapshot();
    const root = s.manifests.find((m) => m.dir === '');
    if (root !== undefined) root.json.scripts = lint === undefined ? {} : { lint };
    return s;
  };

  it('passes the good fixture and this repository, and ignores fixtures and look-alike names', () => {
    assert.deepEqual(checkLintConfig(goodSnapshot(), ['eslint.config.mjs', 'tools/policy/test/fixtures/x/eslint.config.js', 'docs/my-eslint.config.js']), []);
    assert.deepEqual(checkLintConfig(readRepo(REPO_ROOT).snapshot, ['eslint.config.mjs']), []);
  });

  it('refuses any other eslint.config.* and a lint script that lets ESLint look up its config', () => {
    assert.deepEqual(checkLintConfig(goodSnapshot(), ['eslint.config.js', 'packages/engine/eslint.config.ts']).map((f) => `${f.code} ${f.file}`),
      ['E_ESLINT_CONFIG eslint.config.js', 'E_ESLINT_CONFIG packages/engine/eslint.config.ts']);
    for (const lint of ['eslint --max-warnings=0 .', 'eslint --config eslint.config.js .', undefined]) {
      assert.deepEqual(checkLintConfig(withLint(lint), []).map((f) => `${f.code} ${f.file}`), ['E_ESLINT_CONFIG package.json'], String(lint));
    }
    assert.deepEqual(codes(checkLintConfig({ ...goodSnapshot(), manifests: [] }, [])), ['E_ESLINT_CONFIG']);
  });
});

describe('secrets scan', () => {
  // Built at run time so this source file holds no secret-shaped text.
  const samples: Array<[string, string]> = [
    ['private-key-block', `-----BEGIN ${'PRIVATE'} KEY-----`],
    ['private-key-block', `-----BEGIN RSA ${'PRIVATE'} KEY-----`],
    ['keypair-bytes', `[${Array.from({ length: 64 }, (_, i) => (i * 37) % 256).join(', ')}]`],
    ['base58-secret', `const ${'secret'}Key = "${'5Kd3'.repeat(22)}";`],
    ['url-credential', `https://rpc.example.invalid/?api-${'key'}=${'0f3a'.repeat(4)}`],
    ['github-token', `${'gh'}s_${'a1B2'.repeat(9)}`],
    ['aws-access-key', `${'AK'}IA${'Q7RT'.repeat(4)}`],
    ['telegram-bot-token', `123456789:${'AA'}${'h'.repeat(33)}`],
  ];

  it('finds each kind of secret and never prints the matched text', () => {
    for (const [rule, text] of samples) {
      const findings = scanText(`line one\n${text}\n`, 'f.txt');
      assert.equal(findings.length, 1, rule);
      assert.equal(findings[0]?.file, 'f.txt:2');
      assert.match(findings[0]?.message ?? '', new RegExp(`\\(rule ${rule}, fingerprint [0-9a-f]{64}\\)$`));
      assert.ok(!formatFindings(findings).includes(text), rule);
    }
  });

  it('does not flag public chain data: signatures, pubkeys, hashes and 63-byte arrays', () => {
    const sig = `"signature": "${'5Kd3'.repeat(22)}"`;
    const bytes = `[${Array.from({ length: 63 }, () => 1).join(',')}]`;
    const text = [sig, `"pubkey": "${'1'.repeat(32)}"`, '"integrity": "sha512-abc"', bytes, 'api-key header is redacted'].join('\n');
    assert.deepEqual(scanText(text, 'fixture.json'), []);
  });

  it('skips a reviewed match by file, rule and fingerprint only', () => {
    const [rule, text] = samples[4] as [string, string];
    const match = /[?&]api-key=[^&\s"'`]{8,}/.exec(text)?.[0] as string;
    const allowed = [{ file: 'docs/a.md', rule, fingerprint: fingerprint(rule, match), reason: 'reviewed' }];
    assert.deepEqual(scanText(text, 'docs/a.md', allowed), []);
    assert.equal(scanText(text, 'docs/b.md', allowed).length, 1);
    assert.equal(scanText(`${text}x`, 'docs/a.md', allowed).length, 1);
    const second = `${text} ${text.replace('0f3a', '9b9b')}`;
    assert.equal(scanText(second, 'docs/a.md', allowed).length, 1, 'a second, different match on the same line is still found');
  });

  it('finds a keypair array spread over lines: pretty-printed JSON, Prettier with a trailing comma, Uint8Array.from (C01 red-team M5)', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);   // synthetic
    const lines = (text: string): string[] => scanText(text, 'k').map((f) => f.file);
    assert.deepEqual(lines(JSON.stringify(bytes)), ['k:1']);
    assert.deepEqual(lines(`{\n  "key": ${JSON.stringify(bytes, null, 2)}\n}`), ['k:2']);
    assert.deepEqual(lines(`export const k = [\n${bytes.map((b) => `  ${b},`).join('\n')}\n];\n`), ['k:1']);
    assert.deepEqual(lines(`x\nUint8Array.from([\n${[0, 16, 32, 48].map((o) => bytes.slice(o, o + 16).join(',')).join(',\n')}\n])`), ['k:2']);
    assert.deepEqual(lines(JSON.stringify(bytes.slice(0, 63), null, 2)), [], 'a 63-byte array is not a keypair');
    assert.deepEqual(lines(`${JSON.stringify(bytes)}\n${JSON.stringify(bytes)} ${JSON.stringify(bytes)}`), ['k:1', 'k:2'], 'one finding per line and rule');
    const two = scanText(`ok\n${(samples[6] as [string, string])[1]} ${(samples[5] as [string, string])[1]}\n`, 'k');
    assert.deepEqual(two.map((f) => `${f.file} ${/rule ([a-z-]+)/.exec(f.message)?.[1]}`), ['k:2 github-token', 'k:2 aws-access-key'], 'rule order within a line');
  });

  it('finds a keypair with comments between items, in hex, and UTF-16 text with or without a byte-order mark (C01 review R5)', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => (i * 37) % 256);   // synthetic, not a key
    const lines = (text: string): string[] => scanText(text, 'k').map((f) => `${f.file} ${/rule ([a-z0-9-]+)/.exec(f.message)?.[1]}`);
    assert.deepEqual(lines(`[\n${bytes.map((b, i) => `  ${b}, // byte ${i}`).join('\n')}\n]`), ['k:1 keypair-bytes']);
    assert.deepEqual(lines(`x = [ # key\n${bytes.map((b) => `  ${b}, # b`).join('\n')}\n]`), ['k:1 keypair-bytes']);
    assert.deepEqual(lines(`[${bytes.map((b, i) => `/* ${i} */ ${b}`).join(',')}]`), ['k:1 keypair-bytes']);
    const hex = bytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`);
    assert.deepEqual(lines(`\nnew Uint8Array([\n  ${hex.join(', ')},\n]);`), ['k:2 keypair-bytes']);
    assert.deepEqual(lines(`[${hex.map((h) => h.toUpperCase().replace('0X', '0x')).join(',')}]`), ['k:1 keypair-bytes']);
    assert.deepEqual(lines(`[${hex.slice(0, 63).join(', ')}]`), [], '63 hex bytes are not a keypair');
    assert.deepEqual(lines(`[${bytes.slice(0, 63).map((b) => `${b}, // x`).join('\n')}\n]`), [], '63 commented bytes are not a keypair');
    assert.deepEqual(lines(`[1, // unterminated\n${bytes.join(',')}`), [], 'no closing bracket');

    const dir = join(tmp, 'utf16');
    mkdirSync(dir, { recursive: true });
    const pem = (samples[0] as [string, string])[1];
    const swap = (b: Buffer): Buffer => Buffer.from(b).swap16();
    writeFileSync(join(dir, 'k.json'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`ok\n${JSON.stringify(bytes)}\n`, 'utf16le')]));
    writeFileSync(join(dir, 'k-be.json'), Buffer.concat([Buffer.from([0xfe, 0xff]), swap(Buffer.from(`ok\nok\n${JSON.stringify(bytes)}`, 'utf16le'))]));
    writeFileSync(join(dir, 'pem.txt'), Buffer.from(`${pem}\n`, 'utf16le'));
    assert.deepEqual(scanFiles(dir, ['k.json', 'k-be.json', 'pem.txt']).map((f) => `${f.file} ${/rule ([a-z0-9-]+)/.exec(f.message)?.[1]}`),
      ['k.json:2 keypair-bytes', 'k-be.json:3 keypair-bytes', 'pem.txt:1 private-key-block']);
    const nul = `${pem.split('').join('\0')}\n${pem}`;
    assert.deepEqual(lines(nul), ['k:1 private-key-block', 'k:2 private-key-block'], 'one finding per line and rule across both readings');
  });

  it('scans a long gap after a 64-item array in linear time (C01 red-team round 3, A2)', () => {
    // Before the fix the two gaps around the optional trailing comma could split the same space in every way: 40,000
    // spaces took 5.1 s. Linear, each scan takes about a millisecond; the limit leaves a wide margin for a slow runner.
    const items = Array.from({ length: 64 }, (_, i) => (i * 37) % 256).join(',');   // synthetic, not a key
    for (const [what, gap] of [['spaces', ' '.repeat(40_000)], ['comment lines', ' // c\n'.repeat(10_000)]] as const) {
      const start = wallClockNowMs();
      assert.deepEqual(scanText(`[${items}${gap}x`, 'f.txt'), [], 'no closing bracket: not a keypair');
      const ms = wallClockNowMs() - start;
      assert.ok(ms < 500, `${what}: ${ms} ms`);
    }
    assert.equal(scanText(`[${items} ,  // last\n ]`, 'f.txt').length, 1, 'a trailing comma between gaps still matches');
  });

  it('scans many brackets with unterminated or bracket-holding comments in linear time (C01 red-team round 5, A5)', () => {
    // Before the fix every `[` read an unterminated comment to the end of the text ("[/*": 2.7 s for 60 KB), and every
    // `[` inside a comment read all later comments again ("# [" lines: 1.8 s for 60 KB). Now about 1 ms each.
    for (const unit of ['[/*', '[//', '[#', '# [\n', '// [\n', '[1, /*']) {
      const text = unit.repeat(Math.ceil(60_000 / unit.length));
      const start = wallClockNowMs();
      assert.deepEqual(scanText(text, 'f.txt'), []);
      const ms = wallClockNowMs() - start;
      assert.ok(ms < 500, `${JSON.stringify(unit)}: ${ms} ms`);
    }
    const bytes = Array.from({ length: 64 }, (_, i) => (i * 37) % 256);   // synthetic, not a key
    assert.equal(scanText(`# [${bytes.join(', ')}]\n`, 'f.txt').length, 1, 'an array inside a comment is still found');
    assert.equal(scanText(`[ // bytes 0-63\n${bytes.join(',\n')}]`, 'f.txt').length, 1, 'comments without [ between items still match');
    assert.equal(scanText(`[ // key[0..63]\n${bytes.join(',\n')}]`, 'f.txt').length, 0, 'documented limit: a [ in a comment between items hides the array');
  });

  it('scans every file, binary ones included (their UTF-8 and UTF-16 text), and reads the reviewed allowlist (C01 red-team M5)', () => {
    const dir = join(tmp, 'files');
    mkdirSync(join(dir, 'tools/policy'), { recursive: true });
    writeFileSync(join(dir, 'log.txt'), `ok\n${(samples[0] as [string, string])[1]}\n`);
    writeFileSync(join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0xff, 10]), Buffer.from((samples[0] as [string, string])[1])]));
    writeFileSync(join(dir, 'fixture.json'), `\0\n${(samples[0] as [string, string])[1]}\n`);
    assert.deepEqual(scanFiles(dir, ['log.txt', 'blob.bin', 'fixture.json']).map((f) => f.file), ['log.txt:2', 'blob.bin:2', 'fixture.json:2']);
    assert.deepEqual(readAllowlist(dir), []);
    writeFileSync(join(dir, 'tools/policy/secret-allowlist.json'), JSON.stringify([{ file: 'a', rule: 'b', fingerprint: 'c', reason: 'd' }]));
    assert.equal(readAllowlist(dir).length, 1);
    writeFileSync(join(dir, 'tools/policy/secret-allowlist.json'), JSON.stringify([{ file: 'a', rule: 'b', fingerprint: 'c', reason: '' }]));
    assert.throws(() => readAllowlist(dir), /every entry needs/);
  });

  it('skips what is not a regular file, and the CLI refuses it (C01 red-team round 5, A7; EISDIR before)', () => {
    const dir = join(tmp, 'special');
    mkdirSync(join(dir, 'sub.ts'), { recursive: true });                    // a submodule or a file now a directory
    writeFileSync(join(dir, 'key.log'), `${(samples[0] as [string, string])[1]}\n`);
    assert.equal(spawnSync('mkfifo', [join(dir, 'fifo')]).status, 0);       // reading it would never end
    assert.deepEqual(scanFiles(dir, ['sub.ts', 'fifo', 'key.log']).map((f) => f.file), ['key.log:1']);
    assert.equal(isRegularFile(dir, 'key.log'), true);
    assert.equal(isRegularFile(dir, 'missing.log'), false);
    const io = capture();
    assert.equal(scanMain(['key.log', 'sub.ts', 'missing.log'], dir, io), 2);
    assert.equal(io.text(), 'policy: not a regular file, so not scanned: sub.ts, missing.log');
  });

  it('CLI: usage error, findings and a clean log', () => {
    const dir = join(tmp, 'cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'clean.log'), 'tests passed\n');
    writeFileSync(join(dir, 'dirty.log'), `${(samples[5] as [string, string])[1]}\n`);
    const io = capture();
    assert.equal(scanMain([], dir, io), 2);
    assert.equal(scanMain(['dirty.log'], dir, io), 1);
    assert.equal(scanMain(['clean.log'], dir, io), 0);
    assert.match(io.text(), /usage[\s\S]*E_SECRET dirty\.log:1[\s\S]*no secrets found in 1 file/);
    assert.equal(runBin('secrets.ts', ['clean.log'], dir).status, 0);
    assert.equal(runBin('secrets.ts', [join(dir, 'clean.log')], tmp).status, 0, 'absolute paths work from any directory');
    assert.equal(runBin('secrets.ts', ['dirty.log'], dir).status, 1);
  });
});

describe('readRepo', () => {
  it('reads manifests from dir and dir/* workspace patterns of pnpm-workspace.yaml, and reports bad JSON and unsupported patterns', () => {
    const dir = join(tmp, 'repo');
    mkdirSync(join(dir, 'packages/a'), { recursive: true });
    mkdirSync(join(dir, 'packages/no-manifest'), { recursive: true });
    mkdirSync(join(dir, 'tools/x'), { recursive: true });
    writeFileSync(join(dir, 'packages/file.txt'), '');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['ignored/*'] }));
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - packages/*\n  - tools/x\n  - missing/*\n  - 'a/**/b'\n");
    writeFileSync(join(dir, 'packages/a/package.json'), JSON.stringify({ name: 'a' }));
    writeFileSync(join(dir, 'tools/x/package.json'), '{ not json');
    const { snapshot, findings } = readRepo(dir);
    assert.deepEqual(snapshot.manifests.map((m) => m.file), ['package.json', 'packages/a/package.json']);
    assert.deepEqual(findings.map((f) => `${f.code} ${f.file}`), ['E_WORKSPACE_PATTERN pnpm-workspace.yaml', 'E_JSON tools/x/package.json']);
    assert.equal(snapshot.lock, null);
    assert.equal(snapshot.dependenciesMd, null);
    assert.deepEqual(snapshot.workflows, []);
    assert.deepEqual(snapshot.otherLockfiles, []);
  });

  it('reports a missing root manifest, an unreadable lockfile or workspace file, other lockfiles, and reads workflows', () => {
    const dir = join(tmp, 'bare');
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/b.yaml'), 'b');
    writeFileSync(join(dir, '.github/workflows/a.yml'), 'a');
    writeFileSync(join(dir, '.github/workflows/notes.md'), 'c');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    writeFileSync(join(dir, 'yarn.lock'), '');
    const { snapshot, findings } = readRepo(dir);
    assert.deepEqual(codes(findings), ['E_JSON']);
    assert.deepEqual(snapshot.manifests, []);
    assert.deepEqual(snapshot.lock, { lockfileVersion: '9.0', importers: {}, packages: {}, snapshots: {} });
    assert.deepEqual(snapshot.otherLockfiles, ['package-lock.json', 'yarn.lock']);
    assert.equal(snapshot.workspace, null);
    assert.deepEqual(snapshot.workflows.map((w) => w.file), ['.github/workflows/a.yml', '.github/workflows/b.yaml']);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'a: [\n');
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'a: &x 1\n');
    const broken = readRepo(dir);
    assert.deepEqual(broken.findings.map((f) => `${f.code} ${f.file}`), ['E_YAML pnpm-workspace.yaml', 'E_JSON package.json', 'E_LOCK_PARSE pnpm-lock.yaml']);
    assert.equal(broken.snapshot.lock, null);
    const manifestOnly = join(tmp, 'manifest-only');
    mkdirSync(manifestOnly, { recursive: true });
    writeFileSync(join(manifestOnly, 'package.json'), '{}');
    assert.deepEqual(readRepo(manifestOnly).snapshot.manifests.map((m) => m.file), ['package.json']);
  });
});
