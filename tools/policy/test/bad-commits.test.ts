// CI self-tests with deliberately bad commits (B-M30-01 "Tests"). Each test commits a bad change on top of a good
// repository and runs the policy check the way CI does; the check must fail with the expected code. Ported from C01:
// the lockfile is pnpm-lock.yaml, and an install script is caught by the installed-package scan and the age check's
// registry read (pnpm's lockfile has no install-script flag); installed.test.ts also runs a real pnpm install.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, sep } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { main as ageMain, type Packument } from '../age.ts';
import { main as checkMain, runChecks } from '../check.ts';
import { DEFAULT_BASE_REF } from '../config.ts';
import { checkDrift, main as driftMain, guardedFiles, reviewLabel } from '../drift.ts';
import { writeFreeze } from '../freeze.ts';
import { gitAt } from '../git.ts';
import { moduleRefs } from '../imports.ts';
import { applyBadCommit, capture, codes, editJson, editText, goodRepo, REPO_ROOT, runBin, type TempRepo } from './helpers.ts';

describe('the good fixture', () => {
  let repo: TempRepo;
  beforeAll(() => { repo = goodRepo(); });
  afterAll(() => repo.remove());

  it('passes every check (CLI exit 0)', () => {
    const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /all checks passed/);
  });
});

describe('acceptance: deliberately bad commits fail the check', () => {
  it('adding a package with an install script fails CI with E_INSTALL_SCRIPT and nothing else (installed scan and age check)', async () => {
    const repo = goodRepo();
    try {
      const pkg = join(repo.dir, 'node_modules/.pnpm/typescript@6.0.3/node_modules/typescript');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', version: '6.0.3', license: 'Apache-2.0', scripts: { postinstall: 'node steal.js' } }));
      const r = runBin('installed.ts', [repo.dir], repo.dir);
      assert.equal(r.status, 1);
      assert.deepEqual([...r.stderr.matchAll(/policy: (E_[A-Z_]+) /g)].map((m) => m[1]), ['E_INSTALL_SCRIPT']);
      const io = capture();
      const doc = async (): Promise<Packument> => ({ time: { '6.0.3': '2026-04-16T23:38:27Z', '8.4.0': '2026-09-01T00:00:00Z' }, installScripts: { '6.0.3': ['postinstall'] } });
      const git = { ...gitAt(repo.dir), show: () => null };                         // every version is new against the base
      assert.equal(await ageMain(repo.dir, Date.parse('2026-10-07T00:00:00Z'), io, doc, git, 'main', { sleep: async () => {}, nowMs: () => 0 }), 1);
      assert.deepEqual([...io.text().matchAll(/policy: (E_[A-Z_]+) /g)].map((m) => m[1]), ['E_INSTALL_SCRIPT']);
      assert.match(io.text(), /typescript@6\.0\.3 declares postinstall in its registry manifest/);
    } finally {
      repo.remove();
    }
  });

  const cases = [
    { overlay: 'bad-web3-in-engine', code: 'E_WEB3_BANNED', what: 'adding @solana/web3.js to the engine' },
    { overlay: 'bad-signer-runtime-dep', code: 'E_THIRD_PARTY_RUNTIME', what: 'a runtime dependency in the signer' },
  ];
  for (const c of cases) {
    it(`${c.what} fails CI with ${c.code} and nothing else`, () => {
      const repo = goodRepo();
      try {
        applyBadCommit(repo, c.overlay);
        const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
        assert.equal(r.status, 1);
        assert.match(r.stderr, new RegExp(`policy: ${c.code} `));
        assert.deepEqual(codes(runChecks(repo.dir, 'main')), [c.code]);
      } finally {
        repo.remove();
      }
    });
  }
});

describe('freeze of @bot/types (B-M19-01 logic 2)', () => {
  const changeTypes = (repo: TempRepo): void => {
    editText(repo.dir, 'packages/types/src/index.ts', (s) => `${s}export type Added = 2;\n`);
  };

  it('a change to a frozen file fails: FREEZE.json mismatch, no version bump, no sign-offs', () => {
    const repo = goodRepo();
    try {
      changeTypes(repo);
      repo.commit('change frozen types');
      assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED']);
    } finally { repo.remove(); }
  });

  it('re-recording FREEZE.json without a version bump and sign-offs fails', () => {
    const repo = goodRepo();
    try {
      changeTypes(repo);
      writeFreeze(repo.dir, 'packages/types');
      repo.commit('re-freeze without bump');
      assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF']);
    } finally { repo.remove(); }
  });

  it('a bump with a changelog entry still needs both sign-offs', () => {
    const repo = goodRepo();
    try {
      changeTypes(repo);
      editJson(repo.dir, 'packages/types/package.json', (p) => { p['version'] = '1.1.0'; });
      editText(repo.dir, 'packages/types/CHANGELOG.md', (s) => s.replace('## 1.0.0', '## 1.1.0\n\nAdded.\n\nSign-off (group A lead): pending\n\n## 1.0.0'));
      writeFreeze(repo.dir, 'packages/types');
      repo.commit('bump without sign-off');
      const findings = runChecks(repo.dir, 'main');
      assert.deepEqual(codes(findings), ['E_FREEZE_SIGNOFF']);
      assert.equal(findings.length, 2);
    } finally { repo.remove(); }
  });

  it('a bump with a changelog entry and both sign-offs passes', () => {
    const repo = goodRepo();
    try {
      changeTypes(repo);
      editJson(repo.dir, 'packages/types/package.json', (p) => { p['version'] = '1.1.0'; });
      editText(repo.dir, 'packages/types/CHANGELOG.md', (s) => s.replace('## 1.0.0',
        '## 1.1.0\n\nAdded.\n\nSign-off (group A lead): A. Lead\nSign-off (group B lead): B. Lead\n\n## 1.0.0'));
      writeFreeze(repo.dir, 'packages/types');
      repo.commit('signed bump');
      assert.deepEqual(runChecks(repo.dir, 'main'), []);
    } finally { repo.remove(); }
  });
});

describe('freeze of @bot/contract (B-M28-01: the same mechanism as @bot/types)', () => {
  it('a change to its files fails, a re-record without a bump fails, and a signed bump passes', () => {
    const change = (repo: TempRepo): void => editText(repo.dir, 'packages/contract/src/index.ts', (s) => `${s}export const added = 1;\n`);
    const repo = goodRepo();
    try {
      change(repo);
      repo.commit('change frozen contract');
      assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED']);
      writeFreeze(repo.dir, 'packages/contract');
      repo.commit('re-freeze without bump');
      assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF']);
      editJson(repo.dir, 'packages/contract/package.json', (p) => { p['version'] = '1.1.0'; });
      editText(repo.dir, 'packages/contract/CHANGELOG.md', (s) => s.replace('## 1.0.0',
        '## 1.1.0\n\nAdded.\n\nSign-off (group A lead): UI Lead\nSign-off (group B lead): Backend Lead\n\n## 1.0.0'));
      writeFreeze(repo.dir, 'packages/contract');
      repo.commit('signed bump');
      assert.deepEqual(runChecks(repo.dir, 'main'), []);
    } finally { repo.remove(); }
  });
});

describe('repository scan and base ref', () => {
  it('finds a secret in a new, not yet committed file and never prints it', () => {
    const repo = goodRepo();
    try {
      const token = `${'gh'}p_${'Q'.repeat(36)}`;
      writeFileSync(join(repo.dir, 'notes.txt'), `token ${token}\n`);
      const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /E_SECRET notes\.txt:1: possible GitHub token/);
      assert.ok(!r.stderr.includes(token));
    } finally { repo.remove(); }
  });

  it('fails closed when the base ref is missing, and defaults to the integration branch and the working directory', () => {
    const repo = goodRepo();
    const cwd = process.cwd();
    try {
      process.chdir(repo.dir);
      const io = capture();
      assert.equal(checkMain([], {}, io), 1);
      assert.ok(io.text().includes(`E_BASE_REF ${DEFAULT_BASE_REF}`), io.text());
    } finally {
      process.chdir(cwd);
      repo.remove();
    }
  });
});

describe('lockfile and policy files need the review label bound to their content (CI and guard steps)', () => {
  const labelOf = (repo: TempRepo): string => reviewLabel(guardedFiles(gitAt(repo.dir), 'HEAD'));
  /**
   * CI as the run that carries the label: PR_LABELS lists the pull request's labels and PR_LABEL_ADDED is the one this
   * run's `labeled` event added (supervisor ruling 7; `added` tells the test to leave it empty, as a push run does).
   */
  const drift = (repo: TempRepo, labels: string, added: string | null = null): ReturnType<typeof runBin> =>
    runBin('drift.ts', [], repo.dir, { POLICY_BASE_REF: 'main', PR_LABELS: labels, PR_LABEL_ADDED: added ?? labels });
  /** A lockfile change the other checks accept: another (fake) integrity hash for one package. */
  const lockEdit = (repo: TempRepo, tag: string, pkg = 'Typescript'): void =>
    editText(repo.dir, 'pnpm-lock.yaml', (t) => t.replace(new RegExp(`sha512-fixture${pkg}IntegrityHash[A-Za-z]*==`), `sha512-fixture${pkg}IntegrityHash${tag}==`));

  it('fails a lockfile change without its label and passes with deps-reviewed:<hash>; --print-label prints it', () => {
    const repo = goodRepo();
    try {
      lockEdit(repo, 'Changed');
      repo.commit('lockfile change');
      const label = labelOf(repo);
      assert.match(label, /^deps-reviewed:[0-9a-f]{32}$/);
      assert.ok(label.length <= 50, 'GitHub label names are at most 50 characters');
      const printed = runBin('drift.ts', ['--print-label'], repo.dir);
      assert.equal(printed.stdout.trim(), label);
      const without = drift(repo, 'other');
      assert.equal(without.status, 1);
      assert.match(without.stderr, /E_LOCK_DRIFT pnpm-lock\.yaml: changed: pnpm-lock\.yaml\./);
      assert.ok(without.stderr.includes(`"${label}"`), 'the failure names the label to add');
      const io = capture();
      assert.equal(driftMain([], { POLICY_BASE_REF: 'main', PR_LABELS: `x, ${label}`, PR_LABEL_ADDED: label }, gitAt(repo.dir), io), 0);
      assert.match(io.text(), /review label check passed/);
      assert.equal(drift(repo, label).status, 0);
    } finally { repo.remove(); }
  });

  it('the bare deps-reviewed label no longer passes', () => {
    const repo = goodRepo();
    try {
      lockEdit(repo, 'Changed');
      repo.commit('lockfile change');
      const r = drift(repo, 'deps-reviewed');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /E_LOCK_DRIFT/);
    } finally { repo.remove(); }
  });

  it('the label passes only on the run whose own event added it (red team RT-03, supervisor ruling 7)', () => {
    const repo = goodRepo();
    try {
      lockEdit(repo, 'Reviewed');
      repo.commit('reviewed lockfile change');
      const label = labelOf(repo);
      assert.equal(drift(repo, label).status, 0, 'the labeled event');
      const later = drift(repo, label, '');
      assert.equal(later.status, 1, 'a later push run carries the same label but not the event');
      assert.match(later.stderr, /was not added by this run's event, so it is older than this head/);
      assert.equal(drift(repo, label, 'other').status, 1, 'another label was added by this event');
      assert.equal(drift(repo, '', '').status, 1, 'no label at all');
    } finally { repo.remove(); }
  });

  it('a lockfile change pushed after the label was added fails again (the label goes stale)', () => {
    const repo = goodRepo();
    try {
      lockEdit(repo, 'Reviewed');
      repo.commit('reviewed lockfile change');
      const label = labelOf(repo);
      assert.equal(drift(repo, label).status, 0);
      lockEdit(repo, 'Unreviewed');
      repo.commit('later lockfile change');
      const r = drift(repo, label);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /E_LOCK_DRIFT pnpm-lock\.yaml/);
      assert.ok(r.stderr.includes(`"${labelOf(repo)}"`));
    } finally { repo.remove(); }
  });

  it('a lockfile change brought in by merging the base branch also needs a new label', () => {
    const repo = goodRepo();
    try {
      lockEdit(repo, 'Pr');
      repo.commit('pr lockfile change');
      const label = labelOf(repo);
      repo.git('checkout', '-q', 'main');
      lockEdit(repo, 'Main', 'Kit');
      repo.commit('lockfile change on main');
      repo.git('checkout', '-q', 'pr');
      repo.git('merge', '-q', '--no-edit', '-X', 'ours', 'main');
      assert.match(readFileSync(join(repo.dir, 'pnpm-lock.yaml'), 'utf8'), /sha512-fixtureKitIntegrityHashMain==/);
      assert.notEqual(labelOf(repo), label);
      const r = drift(repo, label);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /E_LOCK_DRIFT/);
    } finally { repo.remove(); }
  });

  it('a change to a policy file, the CI workflow, .npmrc, pnpm-workspace.yaml, vitest.config.ts or a fixture under tools/ needs the label too (C01 red-team M3)', () => {
    for (const [path, text] of [['tools/policy/drift.ts', 'export {};\n'], ['eslint.config.mjs', 'export default [];\n'], ['.npmrc', 'ignore-scripts=false\n'],
      ['.github/workflows/ci.yml', 'name: x\n'], ['tsconfig.json', '{}\n'], ['tools/policy/test/fixtures/x/pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
      ['pnpm-workspace.yaml', 'packages:\n  - packages/*\nonlyBuiltDependencies:\n  - evil\n'], ['vitest.config.ts', 'export default {};\n']] as const) {
      const repo = goodRepo();
      try {
        mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
        writeFileSync(join(repo.dir, path), text);
        repo.commit(`change ${path}`);
        const r = drift(repo, '');
        assert.equal(r.status, 1, path);
        assert.match(r.stderr, new RegExp(`E_POLICY_DRIFT ${path.replace(/\./g, '\\.')}: changed: ${path.replace(/\./g, '\\.')}\\.`), path);
        assert.equal(drift(repo, labelOf(repo)).status, 0, path);
      } finally { repo.remove(); }
    }
  });

  it('an age exception or reviewer cell added after the label, or a self-signed freeze, makes the label stale (C01 review R3)', () => {
    const edits: Array<[string, (t: string) => string]> = [
      ['DEPENDENCIES.md', (t) => `${t}| \`typescript@6.0.3\` | GHSA-0000-0000-0000 (made up) | me |\n`],
      ['DEPENDENCIES.md', (t) => t.replace('| Apache-2.0 | fixture |', '| Apache-2.0 | me |')],
      ['packages/types/CHANGELOG.md', (t) => `${t}\nSign-off (group A lead): me\n`],
      ['packages/types/FREEZE.json', (t) => t.replace('"version"', '"version" ')],
    ];
    for (const [file, edit] of edits) {
      const repo = goodRepo();
      try {
        lockEdit(repo, 'Changed');
        repo.commit('reviewed lockfile change');
        const label = labelOf(repo);
        assert.equal(drift(repo, label).status, 0);
        editText(repo.dir, file, edit);
        repo.commit(`edit ${file} after review`);
        const r = drift(repo, label);
        assert.equal(r.status, 1, file);
        assert.match(r.stderr, new RegExp(`changed: .*${file.replace(/\./g, '\\.')}`), file);
      } finally { repo.remove(); }
    }
  });

  it('a second ESLint config needs the label and is refused by the policy check (C01 review R1)', () => {
    for (const path of ['eslint.config.js', 'docs/eslint.config.mjs', 'packages/engine/eslint.config.ts']) {
      const repo = goodRepo();
      try {
        mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
        writeFileSync(join(repo.dir, path), 'export default [{}];\n');
        repo.commit(`add ${path}`);
        const r = drift(repo, '');
        assert.equal(r.status, 1, path);
        assert.match(r.stderr, new RegExp(`E_POLICY_DRIFT ${path.replace(/\./g, '\\.')}`), path);
        assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_ESLINT_CONFIG'], path);
      } finally { repo.remove(); }
    }
  });

  it('renaming a guarded file away counts as a change to it', () => {
    const repo = goodRepo();
    try {
      mkdirSync(join(repo.dir, 'docs'));
      repo.git('mv', '.npmrc', 'docs/npmrc.txt');
      repo.commit('move .npmrc out of the guarded paths');
      const r = drift(repo, '');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /E_POLICY_DRIFT \.npmrc/);
    } finally { repo.remove(); }
  });

  it('a change outside the guarded paths needs no label', () => {
    const repo = goodRepo();
    try {
      mkdirSync(join(repo.dir, 'packages/engine/src'), { recursive: true });
      writeFileSync(join(repo.dir, 'packages/engine/src/a.ts'), 'export const a = 1;\n');
      repo.commit('engine code');
      assert.equal(drift(repo, '').status, 0);
    } finally { repo.remove(); }
  });

  // The guard workflow is a follow-up card, not this PR (supervisor ruling 2 for round 1 review F2); this keeps the
  // property the card needs: the base branch's copy of the check catches a pull request that neutered its own copy.
  it('a base copy of the drift check catches a neutered copy in the pull request (C01 red-team M3)', () => {
    const repo = goodRepo();
    const base = join(repo.dir, '..', `${basename(repo.dir)}-base`);
    try {
      repo.git('checkout', '-q', 'main');
      cpSync(join(REPO_ROOT, 'tools/policy'), join(repo.dir, 'tools/policy'), { recursive: true, filter: (src) => !src.includes(`${sep}test`) });
      repo.commit('policy tools on main');
      repo.git('checkout', '-q', 'pr');
      repo.git('merge', '-q', '--no-edit', 'main');
      lockEdit(repo, 'Unreviewed');
      writeFileSync(join(repo.dir, 'tools/policy/drift.ts'), "export function main(): number { return 0; }\n");
      repo.commit('lockfile change and a neutered drift check');
      const own = spawnSync(process.execPath, ['tools/policy/bin/drift.ts'], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, POLICY_BASE_REF: 'main', PR_LABELS: '' } });
      assert.equal(own.status, 0, 'the pull request\'s own copy is neutered');
      repo.git('worktree', 'add', '-q', '--detach', base, 'main');
      const guard = spawnSync(process.execPath, [join(base, 'tools/policy/bin/drift.ts')], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, POLICY_BASE_REF: 'main', PR_LABELS: '' } });
      assert.equal(guard.status, 1, guard.stderr);
      assert.match(guard.stderr, /E_LOCK_DRIFT pnpm-lock\.yaml: changed: pnpm-lock\.yaml, tools\/policy\/drift\.ts\./);
    } finally {
      rmSync(base, { recursive: true, force: true });
      repo.remove();
    }
  });

  it('the drift check imports only node: built-ins and modules beside it, so the guard runs it without an install', () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const ref of moduleRefs(readFileSync(join(REPO_ROOT, file), 'utf8'), file)) {
        const s = ref.specifier as string;
        if (s.startsWith('node:')) continue;
        assert.ok(s.startsWith('./') || s.startsWith('../'), `${file} imports ${s}`);
        visit(posix.normalize(posix.join(posix.dirname(file), s)));
      }
    };
    visit('tools/policy/bin/drift.ts');
    assert.deepEqual([...seen].sort(), ['tools/policy/bin/drift.ts', 'tools/policy/config.ts', 'tools/policy/drift.ts', 'tools/policy/finding.ts', 'tools/policy/git.ts']);
  });

  it('a removed lockfile fails and cannot be labelled; nothing to check without a guarded change', () => {
    assert.deepEqual(checkDrift(['pnpm-lock.yaml'], ['deps-reviewed'], []).map((f) => f.code), ['E_LOCK_DRIFT']);
    assert.deepEqual(checkDrift(['README.md'], [], []), []);
  });

  it('fails closed without a base ref; a file missing at a ref has no bytes', () => {
    const repo = goodRepo();
    try {
      assert.equal(gitAt(repo.dir).blob('HEAD', 'missing.txt'), null);
      assert.equal(gitAt(repo.dir).blob('HEAD', '.npmrc')?.toString(), 'ignore-scripts=true\nengine-strict=true\n');
      const io = capture();
      assert.equal(driftMain([], {}, gitAt(repo.dir), io), 1);
      assert.ok(io.text().includes(`E_BASE_REF ${DEFAULT_BASE_REF}`), io.text());
    } finally { repo.remove(); }
  });
});

describe('other lockfiles (C01: npm-shrinkwrap.json; an install from them would bypass the checked lockfile)', () => {
  it('a committed root npm-shrinkwrap.json, package-lock.json or yarn.lock fails the check', () => {
    for (const file of ['npm-shrinkwrap.json', 'package-lock.json', 'yarn.lock']) {
      const repo = goodRepo();
      try {
        writeFileSync(join(repo.dir, file), '{}\n');
        repo.commit(`add ${file}`);
        const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
        assert.equal(r.status, 1, file);
        assert.match(r.stderr, new RegExp(`policy: E_OTHER_LOCKFILE ${file.replace(/\./g, '\\.')}`), file);
        assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_OTHER_LOCKFILE'], file);
      } finally { repo.remove(); }
    }
  });
});

describe('symbolic links (C01 red-team round 3, finding A1)', () => {
  const found = (dir: string): string[] => runChecks(dir, 'main').map((f) => `${f.code} ${f.file}`);

  it('a committed link that takes a signer module out of its package fails with E_SYMLINK alone, also through the CLI', () => {
    const repo = goodRepo();
    try {
      mkdirSync(join(repo.dir, 'lib'));
      writeFileSync(join(repo.dir, 'lib/hop.ts'), "export * from './fc.ts';\n");          // Node resolves './fc.ts' here: lib/fc.ts
      writeFileSync(join(repo.dir, 'lib/fc.ts'), "export * from 'fast-check';\n");
      mkdirSync(join(repo.dir, 'packages/signer/src'));
      writeFileSync(join(repo.dir, 'packages/signer/src/fc.ts'), 'export const decoy = 1;\n'); // what the static check resolves
      writeFileSync(join(repo.dir, 'packages/signer/src/index.ts'), "import * as hop from './hop.ts';\n\nexport const n: number = Object.keys(hop).length;\n");
      symlinkSync('../../../lib/hop.ts', join(repo.dir, 'packages/signer/src/hop.ts'));
      repo.commit('signer link');
      assert.match(repo.git('ls-files', '--stage', 'packages/signer/src/hop.ts'), /^120000 /);
      const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^policy: E_SYMLINK packages\/signer\/src\/hop\.ts: symbolic links are not allowed/m);
      assert.deepEqual(found(repo.dir), ['E_SYMLINK packages/signer/src/hop.ts']);
    } finally { repo.remove(); }
  });

  it('directory links, untracked links and a link the checkout wrote as a plain file fail without a crash (EISDIR before)', () => {
    const repo = goodRepo();
    try {
      mkdirSync(join(repo.dir, 'lib'));
      writeFileSync(join(repo.dir, 'lib/a.ts'), 'export const a = 1;\n');
      writeFileSync(join(repo.dir, 'notes.md'), 'notes\n');
      symlinkSync('../../../lib', join(repo.dir, 'packages/types/src/lib'));           // in the frozen package
      symlinkSync('../../lib', join(repo.dir, 'packages/engine/lib'));
      symlinkSync('lib/a.ts', join(repo.dir, 'plain.ts'));
      repo.commit('links');
      rmSync(join(repo.dir, 'plain.ts'));
      writeFileSync(join(repo.dir, 'plain.ts'), 'lib/a.ts');                           // as core.symlinks=false checks it out
      symlinkSync(repo.dir, join(repo.dir, 'untracked'));                              // not committed, not ignored
      rmSync(join(repo.dir, 'notes.md'));                                              // tracked but deleted: not a link
      assert.deepEqual(found(repo.dir), ['E_SYMLINK packages/engine/lib', 'E_SYMLINK packages/types/src/lib', 'E_SYMLINK plain.ts', 'E_SYMLINK untracked']);
    } finally { repo.remove(); }
  });
});

describe('submodules and paths that are not regular files (C01 red-team round 5, A7)', () => {
  const found = (dir: string): string[] => runChecks(dir, 'main').map((f) => `${f.code} ${f.file}`);

  it('a gitlink (mode 160000) and a nested repository fail with E_SUBMODULE alone, also through the CLI (EISDIR before)', () => {
    const repo = goodRepo();
    try {
      repo.git('update-index', '--add', '--cacheinfo', `160000,${repo.git('rev-parse', 'HEAD').trim()},packages/engine/src/vendor`);
      mkdirSync(join(repo.dir, 'packages/engine/src/vendor'), { recursive: true });   // as a checkout without submodules leaves it
      assert.match(repo.git('ls-files', '--stage', 'packages/engine/src/vendor'), /^160000 /);
      const r = runBin('check.ts', [repo.dir], repo.dir, { POLICY_BASE_REF: 'main' });
      assert.equal(r.status, 1);
      assert.equal(r.stderr, 'policy: E_SUBMODULE packages/engine/src/vendor: submodules and nested git repositories are not allowed: their files belong '
        + 'to another repository, so the checks cannot read them; commit the files themselves. The other checks did not run\npolicy: 1 finding(s)\n');
      mkdirSync(join(repo.dir, 'nested'));
      repo.git('-C', 'nested', 'init', '-q');
      writeFileSync(join(repo.dir, 'nested/a.txt'), 'a\n');
      assert.deepEqual(found(repo.dir), ['E_SUBMODULE nested', 'E_SUBMODULE packages/engine/src/vendor']);
    } finally { repo.remove(); }
  });

  it('a tracked file replaced by a directory is skipped, and the files in it are checked', () => {
    const repo = goodRepo();
    try {
      writeFileSync(join(repo.dir, 'notes.ts'), 'export const n = 1;\n');
      repo.commit('notes');
      rmSync(join(repo.dir, 'notes.ts'));
      mkdirSync(join(repo.dir, 'notes.ts'));
      writeFileSync(join(repo.dir, 'notes.ts/key.txt'), `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\n`);
      assert.deepEqual(found(repo.dir), ['E_SECRET notes.ts/key.txt:1']);
    } finally { repo.remove(); }
  });
});
