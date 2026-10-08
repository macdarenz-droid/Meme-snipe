// Installed-package scan (B-M30-01 edge case; review finding m1): an install script or binding.gyp in any installed
// package fails, whatever the lockfile says (pnpm's v9 lockfile records no install-script flag at all). Ported from
// C01 to pnpm's layout: each package is a real directory at node_modules/.pnpm/<id>/node_modules/<name>, every other
// entry a link. The allowlist's licence cells are compared with the installed packages here too.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'vitest';
import { checkInstalled, declaredLicence, installedPackages, main } from '../installed.ts';
import { readRepo } from '../repo.ts';
import { capture, codes, FIXTURES, REPO_ROOT, runBin } from './helpers.ts';

/** A copy of the good fixture with the given files written under it. */
function tree(files: Record<string, string>): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'installed-'));
  cpSync(join(FIXTURES, 'good'), dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

const store = (id: string, name: string): string => `node_modules/.pnpm/${id}/node_modules/${name}`;
const pkg = (name: string, scripts?: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, version: '1.0.0', scripts, ...extra });
const scan = (dir: string) => checkInstalled(dir, readRepo(dir).snapshot);

describe('installed packages', () => {
  it('a clean install passes and every package is counted, scoped ones included; links are not packages', () => {
    const t = tree({
      'node_modules/.pnpm/lock.yaml': 'lockfileVersion: 9.0\n',
      'node_modules/.pnpm/node_modules/.keep': '',
      'node_modules/.modules.yaml': '',
      [`${store('a@1.0.0', 'a')}/package.json`]: pkg('a', { test: 'x', prepare: 'only for git dependencies' }),
      [`${store('b@1.0.0', 'b')}/package.json`]: pkg('b'),
      [`${store('@s+c@1.0.0', '@s/c')}/package.json`]: pkg('@s/c'),
      [`${store('@s+c@1.0.0', '@s/.cache')}/x`]: '',
      [`${store('d@1.0.0', 'd')}/package.json`]: JSON.stringify({ name: 'd', scripts: null }),
      [`${store('e@1.0.0', 'e')}/package.json`]: 'null',
      [`${store('n@1.0.0', 'not-a-package')}/readme`]: '',
      'node_modules/.pnpm/stray.txt': '',
      'node_modules/.pnpm/empty@1.0.0/readme': '',
    });
    try {
      symlinkSync('../../b@1.0.0/node_modules/b', join(t.dir, store('a@1.0.0', 'b')));
      mkdirSync(join(t.dir, 'node_modules/.pnpm/a@1.0.0/node_modules/@s'));
      symlinkSync('../../../@s+c@1.0.0/node_modules/@s/c', join(t.dir, 'node_modules/.pnpm/a@1.0.0/node_modules/@s/c'));
      symlinkSync('.pnpm/a@1.0.0/node_modules/a', join(t.dir, 'node_modules/a'));
      symlinkSync('../packages/types', join(t.dir, 'node_modules/linked'));
      const r = scan(t.dir);
      assert.deepEqual(r.findings, []);
      assert.deepEqual(installedPackages(t.dir).map((p) => p.dir), [
        store('@s+c@1.0.0', '@s/c'), store('a@1.0.0', 'a'), store('b@1.0.0', 'b'), store('d@1.0.0', 'd'), store('e@1.0.0', 'e'),
        store('n@1.0.0', 'not-a-package'),
      ]);
      assert.equal(r.packages, 6);
    } finally { t.remove(); }
  });

  it('fails on preinstall, install and postinstall scripts in any installed package, scoped ones included', () => {
    const t = tree({
      [`${store('a@1.0.0', 'a')}/package.json`]: pkg('a', { postinstall: 'node steal.js' }),
      [`${store('b@1.0.0', 'b')}/package.json`]: pkg('b', { install: 'x' }),
      [`${store('@s+c@1.0.0', '@s/c')}/package.json`]: pkg('@s/c', { preinstall: '' }),
      [`${store('f@1.0.0_peer@2.0.0', 'f')}/package.json`]: pkg('f', { postinstall: 'x' }),
    });
    try {
      const { findings } = scan(t.dir);
      assert.deepEqual(findings.map((f) => `${f.code} ${f.file}`).sort(), [
        `E_INSTALL_SCRIPT ${store('@s+c@1.0.0', '@s/c')}/package.json`,
        `E_INSTALL_SCRIPT ${store('a@1.0.0', 'a')}/package.json`,
        `E_INSTALL_SCRIPT ${store('b@1.0.0', 'b')}/package.json`,
        `E_INSTALL_SCRIPT ${store('f@1.0.0_peer@2.0.0', 'f')}/package.json`,
      ]);
      assert.match(findings.find((f) => f.file === `${store('a@1.0.0', 'a')}/package.json`)?.message ?? '', /"postinstall"/);
    } finally { t.remove(); }
  });

  it('fails on a binding.gyp (node-gyp rebuild on install) and on an unreadable manifest', () => {
    const t = tree({
      [`${store('g@1.0.0', 'g')}/package.json`]: JSON.stringify({ name: 'g', gypfile: false }),
      [`${store('g@1.0.0', 'g')}/binding.gyp`]: '{}',
      [`${store('h@1.0.0', 'h')}/package.json`]: '{ not json',
    });
    try {
      const { findings } = scan(t.dir);
      assert.deepEqual(findings.map((f) => `${f.code} ${f.file}`), [`E_INSTALL_SCRIPT ${store('g@1.0.0', 'g')}/binding.gyp`, `E_INSTALLED_MANIFEST ${store('h@1.0.0', 'h')}/package.json`]);
    } finally { t.remove(); }
  });

  it('fails closed when nothing is installed', () => {
    const t = tree({ 'node_modules/a/package.json': pkg('a') });
    try {
      assert.deepEqual(codes(scan(t.dir).findings), ['E_NOT_INSTALLED']);
      const r = runBin('installed.ts', [t.dir], t.dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /policy: E_NOT_INSTALLED node_modules\/\.pnpm/);
    } finally { t.remove(); }
  });

  it('compares the allowlist licence with each installed package of the allowlist (the v9 lockfile records none)', () => {
    const ok = tree({
      [`${store('@solana+kit@8.4.0', '@solana/kit')}/package.json`]: JSON.stringify({ name: '@solana/kit', version: '8.4.0', license: 'MIT' }),
      [`${store('typescript@6.0.3', 'typescript')}/package.json`]: JSON.stringify({ name: 'typescript', version: '6.0.3', license: 'Apache-2.0' }),
    });
    try {
      const r = scan(ok.dir);
      assert.deepEqual(r.findings, []);
      assert.deepEqual([r.verified, r.unverified], [2, 1], '@solana/addresses is not installed in this tree');
    } finally { ok.remove(); }
    const bad = tree({
      [`${store('@solana+kit@8.4.0', '@solana/kit')}/package.json`]: JSON.stringify({ name: '@solana/kit', version: '8.4.0', license: 'GPL-3.0' }),
      [`${store('typescript@6.0.3', 'typescript')}/package.json`]: JSON.stringify({ name: 'typescript', version: '6.0.3' }),
      [`${store('typescript@9.9.9', 'typescript')}/package.json`]: JSON.stringify({ name: 'typescript', version: '9.9.9', license: 'WTFPL' }),
    });
    try {
      const { findings } = scan(bad.dir);
      assert.deepEqual(findings.map((f) => `${f.code} ${f.message}`), [
        'E_LICENCE_MISMATCH @solana/kit: the allowlist says "MIT", the installed @solana/kit@8.4.0 declares "GPL-3.0"',
        'E_LICENCE_MISMATCH typescript: the allowlist says "Apache-2.0", the installed typescript@6.0.3 declares "none declared"',
      ], 'a version the lockfile does not install (typescript 9.9.9) is not compared');
    } finally { bad.remove(); }
  });

  it('reads the licence as npm writes it: SPDX string, legacy { type } object or legacy licenses list', () => {
    assert.equal(declaredLicence({ license: 'MIT' }), 'MIT');
    assert.equal(declaredLicence({ license: { type: 'BSD-2-Clause', url: 'x' } }), 'BSD-2-Clause');
    assert.equal(declaredLicence({ licenses: [{ type: 'MIT' }] }), 'MIT');
    assert.equal(declaredLicence({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }, 'junk'] }), '(MIT OR Apache-2.0)');
    assert.equal(declaredLicence({ license: '' }), null);
    assert.equal(declaredLicence({ license: { url: 'x' } }), null);
    assert.equal(declaredLicence({ licenses: [] }), null);
    assert.equal(declaredLicence({}), null);
  });

  it('the CLI fails on a bad tree and passes this repository after pnpm install --frozen-lockfile', () => {
    const t = tree({ [`${store('a@1.0.0', 'a')}/package.json`]: pkg('a', { install: 'x' }) });
    try {
      const io = capture();
      const cwd = process.cwd();
      try {
        process.chdir(t.dir);
        assert.equal(main([], io), 1);
      } finally { process.chdir(cwd); }
      assert.match(io.text(), /E_INSTALL_SCRIPT node_modules\/\.pnpm\/a@1\.0\.0\/node_modules\/a\/package\.json[\s\S]*1 finding\(s\)/);
    } finally { t.remove(); }
    const r = runBin('installed.ts', [], REPO_ROOT);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\d+ installed packages scanned, no install scripts; licences match for \d+ allowlisted packages/);
  });
});

describe('acceptance: a real pnpm install of a package with an install script fails CI (B-M30-01)', () => {
  // pnpm 10.28.0 with this repository's settings: ignore-scripts=true stops the script, and with it set pnpm's
  // strictDepBuilds does not fail the install (checked on this repository); the installed-package scan, which CI runs
  // right after the install, is what fails. No network: the dependency is a local directory.
  it('the script does not run, and installed.ts fails with E_INSTALL_SCRIPT and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pnpm-install-'));
    try {
      mkdirSync(join(dir, 'dep'));
      writeFileSync(join(dir, 'dep/package.json'), JSON.stringify({
        name: 'has-postinstall', version: '1.0.0', license: 'MIT', scripts: { postinstall: "node -e \"require('fs').writeFileSync('RAN','')\"" },
      }));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dependencies: { 'has-postinstall': 'file:./dep' } }));
      cpSync(join(REPO_ROOT, '.npmrc'), join(dir, '.npmrc'));
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'strictDepBuilds: true\nblockExoticSubdeps: true\n');
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_|^pnpm_/i.test(k)));
      const install = spawnSync('pnpm', ['install', '--offline'], { cwd: dir, encoding: 'utf8', env });
      assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
      assert.ok(existsSync(join(dir, store('has-postinstall@file+dep', 'has-postinstall'), 'package.json')), 'installed into the virtual store');
      assert.equal(existsSync(join(dir, 'dep/RAN')) || existsSync(join(dir, store('has-postinstall@file+dep', 'has-postinstall'), 'RAN')), false, 'the postinstall script did not run');
      const r = runBin('installed.ts', [dir], dir);
      assert.equal(r.status, 1);
      assert.deepEqual([...r.stderr.matchAll(/policy: (E_[A-Z_]+) /g)].map((m) => m[1]), ['E_INSTALL_SCRIPT']);
      assert.match(r.stderr, /has-postinstall\/package\.json: installed package has a "postinstall" script/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
