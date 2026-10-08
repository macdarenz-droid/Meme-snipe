// Unit tests: lockfile and package.json checks (B-M30-01 logic 1, 2, 4, 6). Each case breaks the good fixture in
// one way and asserts the exact finding codes. Ported from C01 (package-lock.json v3) to pnpm-lock.yaml v9: the
// npm-only helpers (install-path names, Node-style resolution through nested node_modules, the tarball URL npm
// records) have pnpm counterparts (name@version ids, snapshot keys with resolved peers, link: importers, an
// integrity-only registry resolution), and each C01 case is kept against its counterpart.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import {
  aliasTarget, checkLockfile, closure, depTarget, describeEntry, IMPORTER_FIELDS, IMPORTER_PRODUCTION_FIELDS, linkDir, readLock,
  splitId, thirdPartyEntries, withoutPeers, type PackageEntry, type PnpmLock, type Snapshot,
} from '../lockfile.ts';
import { checkManifests } from '../manifests.ts';
import type { Manifest, RepoSnapshot } from '../repo.ts';
import { codes, goodSnapshot } from './helpers.ts';

const lockOf = (s: RepoSnapshot): PnpmLock => s.lock as PnpmLock;
const manifest = (s: RepoSnapshot, name: string): Manifest => s.manifests.find((m) => m.json.name === name) as Manifest;
const registry = (integrity = 'sha512-x'): PackageEntry => ({ resolution: { integrity } });
/** Adds `name@version` as a registry package with its snapshot. */
function addPackage(lock: PnpmLock, id: string, snap: Snapshot = {}, entry: PackageEntry = registry()): void {
  lock.packages[id] = entry;
  lock.snapshots[id] = snap;
}
function addDep(lock: PnpmLock, importer: string, name: string, version: string, field: 'dependencies' | 'optionalDependencies' | 'devDependencies' = 'dependencies'): void {
  const imp = lock.importers[importer] ?? (lock.importers[importer] = {});
  imp[field] = { ...imp[field], [name]: { specifier: version, version } };
}
const emptyLock = (): PnpmLock => ({ lockfileVersion: '9.0', importers: {}, packages: {}, snapshots: {} });

describe('lockfile helpers', () => {
  it('splits ids and versions (C01: names and classifies install paths)', () => {
    assert.deepEqual(splitId('@s/b@1.0.0'), ['@s/b', '1.0.0']);
    assert.deepEqual(splitId('a@1.0.0'), ['a', '1.0.0']);
    assert.equal(splitId('nover'), null);
    assert.equal(withoutPeers('8.70.1(eslint@10.11.0)(typescript@6.0.3)'), '8.70.1');
    assert.equal(withoutPeers('1.0.0'), '1.0.0');
    assert.deepEqual(depTarget('a', '1.0.0'), { kind: 'package', name: 'a', version: '1.0.0', snapshot: 'a@1.0.0', pkg: 'a@1.0.0' });
    assert.deepEqual(depTarget('@bot/types', 'link:../types'), { kind: 'link', path: '../types' });
    assert.deepEqual(depTarget('a', 'file:dep'), { kind: 'other', text: 'file:dep' });
    assert.deepEqual(depTarget('a', 'https://example.com/a.tgz'), { kind: 'other', text: 'https://example.com/a.tgz' });
    assert.deepEqual(depTarget('a', 'git+ssh://git@github.com/x/y.git#abc'), { kind: 'other', text: 'git+ssh://git@github.com/x/y.git#abc' });
    assert.deepEqual(thirdPartyEntries(emptyLock()), []);
  });

  it('reads the real package of an alias install from the version text (C01 red-team M1)', () => {
    const t = depTarget('@solana/rpc-legacy', '@solana/web3.js@1.95.6');
    assert.deepEqual(t, { kind: 'package', name: '@solana/web3.js', version: '1.95.6', snapshot: '@solana/web3.js@1.95.6', pkg: '@solana/web3.js@1.95.6' });
    assert.deepEqual(depTarget('x', 'y@1.0.0(peer@2.0.0)'), { kind: 'package', name: 'y', version: '1.0.0', snapshot: 'y@1.0.0(peer@2.0.0)', pkg: 'y@1.0.0' });
    const lock = emptyLock();
    addDep(lock, '.', 'x', '@solana/web3.js@1.95.6');
    addPackage(lock, '@solana/web3.js@1.95.6');
    const entries = thirdPartyEntries(lock);
    assert.deepEqual(entries.map((e) => [e.name, e.version, [...e.aliases]]), [['@solana/web3.js', '1.95.6', ['x']]]);
    assert.equal(describeEntry(entries[0] as { name: string; aliases: Set<string> }), '@solana/web3.js (installed as x)');
    assert.equal(describeEntry({ name: 'a', aliases: new Set() }), 'a');
  });

  it('reads npm: alias specs (C01, verbatim); a registry package records only its integrity (C01: tarball URL)', () => {
    assert.equal(aliasTarget('npm:@solana/web3.js@1.95.6'), '@solana/web3.js');
    assert.equal(aliasTarget('npm:left-pad'), 'left-pad');
    assert.equal(aliasTarget('1.95.6'), null);
    assert.equal(aliasTarget('npm:'), null);
    const s = goodSnapshot();
    assert.deepEqual(lockOf(s).packages['@solana/kit@8.4.0']?.resolution, { integrity: 'sha512-fixtureKitIntegrityHashNotARealOne==' });
  });

  it('resolves workspace links relative to the importer (C01: resolves like Node and follows workspace links)', () => {
    assert.equal(linkDir('packages/engine', '../types'), 'packages/types');
    assert.equal(linkDir('.', 'packages/x'), 'packages/x');
    assert.equal(linkDir('packages/a/b', '../../c'), 'packages/c');
    assert.equal(linkDir('packages/engine', '../..'), '.');
    assert.equal(linkDir('packages/engine', './sub/'), 'packages/engine/sub');
  });

  it('computes the closure through snapshots and links; reports what it cannot resolve (C01: production closure)', () => {
    const lock = emptyLock();
    addDep(lock, '.', 'a', '1.0.0');
    addDep(lock, '.', 'dev', '1.0.0', 'devDependencies');
    addDep(lock, '.', '@bot/x', 'link:packages/x');
    addPackage(lock, 'a@1.0.0', { dependencies: { b: '1.0.0', a: '1.0.0' }, optionalDependencies: { opt: '1.0.0', gone: '1.0.0' } });
    addDep(lock, '.', 'gone-too', '1.0.0', 'optionalDependencies');
    addPackage(lock, 'b@1.0.0');
    addPackage(lock, 'opt@1.0.0');
    addPackage(lock, 'dev@1.0.0');
    addDep(lock, 'packages/x', 'c', '1.0.0');
    addDep(lock, 'packages/x', 'xdev', '1.0.0', 'devDependencies');
    addPackage(lock, 'c@1.0.0');
    const prod = closure(lock, ['.'], IMPORTER_PRODUCTION_FIELDS);
    assert.deepEqual([...prod.packages].sort(), ['a@1.0.0', 'b@1.0.0', 'c@1.0.0', 'opt@1.0.0']);
    assert.deepEqual([...prod.importers].sort(), ['.', 'packages/x']);
    assert.deepEqual(prod.unresolved, [], 'optional dependencies with no packages entry are skipped');
    assert.deepEqual([...closure(lock, ['.'], IMPORTER_FIELDS).packages].sort(), ['a@1.0.0', 'b@1.0.0', 'c@1.0.0', 'dev@1.0.0', 'opt@1.0.0'],
      'a linked package contributes its production dependencies only');
    const z = emptyLock();
    addDep(z, '.', 'z', '1.0.0');
    assert.deepEqual(closure(z, ['.'], IMPORTER_PRODUCTION_FIELDS).unresolved, ['(root) → z@1.0.0 has no packages entry', 'z@1.0.0 has no snapshots entry']);
    assert.deepEqual(closure(emptyLock(), ['packages/x'], IMPORTER_PRODUCTION_FIELDS).unresolved, ['importer packages/x is not in the lockfile']);
    const f = emptyLock();
    addDep(f, '.', 'w', 'file:../outside');
    assert.deepEqual(closure(f, ['.'], IMPORTER_PRODUCTION_FIELDS).unresolved, ['(root) → w is "file:../outside", not a registry package or workspace link']);
  });

  it('reads pnpm-lock.yaml and fails closed on what it does not understand', () => {
    assert.match((readLock('a: [\n') as { error: string }).error, /line 1/);
    assert.deepEqual(readLock('- a\n'), { error: 'not a YAML mapping' });
    assert.deepEqual(readLock("lockfileVersion: '9.0'\nimporters: x\n"), { error: 'importers, packages and snapshots must be mappings' });
    assert.deepEqual(readLock("lockfileVersion: '9.0'\nimporters:\n  .: x\n"), { error: 'importer "." is not a mapping' });
    assert.deepEqual(readLock("importers:\n  .:\n    dependencies: x\n"), { error: 'importer "." dependencies is not a mapping' });
    assert.deepEqual(readLock("importers:\n  .:\n    dependencies:\n      a: x\n"), { error: 'importer "." dependencies.a needs a specifier and a version' });
    assert.deepEqual(readLock('packages:\n  a@1.0.0: {}\n'), { error: 'package "a@1.0.0" has no resolution' });
    assert.deepEqual(readLock('snapshots:\n  a@1.0.0: x\n'), { error: 'snapshot "a@1.0.0" is not a mapping' });
    assert.deepEqual(readLock('snapshots:\n  a@1.0.0:\n    dependencies: x\n'), { error: 'snapshot "a@1.0.0" dependencies is not a mapping of versions' });
    assert.match((readLock("lockfileVersion: '9.0'\noverrides:\n  a: 1.0.0\n") as { error: string }).error, /unexpected top-level field\(s\) overrides/);
    assert.match((readLock("lockfileVersion: '9.0'\npatchedDependencies: {}\n") as { error: string }).error, /patchedDependencies/);
    const ok = readLock("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependenciesMeta:\n      a:\n        injected: true\n");
    assert.deepEqual(ok, { lock: { lockfileVersion: '9.0', importers: { '.': {} }, packages: {}, snapshots: {} } });
    assert.deepEqual((readLock('packages:\n  a@1.0.0:\n    resolution: {integrity: sha512-x}\n    deprecated: old\n') as { lock: PnpmLock }).lock.packages,
      { 'a@1.0.0': { resolution: { integrity: 'sha512-x' }, deprecated: 'old' } });
  });
});

describe('checkLockfile', () => {
  it('passes the good fixture', () => {
    assert.deepEqual(checkLockfile(goodSnapshot()), []);
  });

  it('requires a v9 lockfile (C01: v3) and refuses other package managers\' lockfiles (C01: npm-shrinkwrap.json)', () => {
    const s = goodSnapshot();
    assert.deepEqual(codes(checkLockfile({ ...s, lock: null })), ['E_LOCK_MISSING']);
    lockOf(s).lockfileVersion = '6.0';
    assert.deepEqual(codes(checkLockfile(s)), ['E_LOCK_VERSION']);
    for (const f of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
      assert.deepEqual(codes(checkLockfile({ ...goodSnapshot(), otherLockfiles: [f] })), ['E_OTHER_LOCKFILE'], f);
    }
  });

  it('treats a lockfile without importers as missing every workspace dependency', () => {
    const s = goodSnapshot();
    lockOf(s).importers = {};
    assert.deepEqual(codes(checkLockfile(s)), ['E_LOCK_UNRESOLVED']);
  });

  it('refuses an importer that is not a workspace package (C01: install scripts on workspace entries are covered by installed.ts)', () => {
    const s = goodSnapshot();
    lockOf(s).importers['packages/ghost'] = {};
    assert.deepEqual(codes(checkLockfile(s)), ['E_LOCK_IMPORTER']);
  });

  it('refuses non-registry sources, git and file links, and missing or weak integrity', () => {
    const cases: Array<[string, PackageEntry, string]> = [
      ['gitdep@1.0.0', { resolution: { commit: 'abc', repo: 'git+ssh://git@github.com/x/bot.git', type: 'git' } }, 'E_LOCK_SOURCE'],
      ['urldep@1.0.0', { resolution: { tarball: 'https://example.com/urldep.tgz', integrity: 'sha512-x' } }, 'E_LOCK_SOURCE'],
      ['notgz@1.0.0', { resolution: { tarball: 'https://registry.npmjs.org/notgz', integrity: 'sha512-x' } }, 'E_LOCK_SOURCE'],
      ['nores@1.0.0', { resolution: {} }, 'E_LOCK_INTEGRITY'],
      ['dirdep@1.0.0', { resolution: { directory: '../outside', type: 'directory' } }, 'E_LOCK_SOURCE'],
      ['filelink@file:../outside', { resolution: { directory: '../outside', type: 'directory' } }, 'E_LOCK_SOURCE'],
      ['sha1@1.0.0', registry('sha1-x'), 'E_LOCK_INTEGRITY'],
      ['@bot/types-fake@1.0.0', registry(), 'E_INTERNAL_NOT_LINKED'],
      ['nover', registry(), 'E_LOCK_SOURCE'],
      ['range@^1.0.0', registry(), 'E_LOCK_SOURCE'],
    ];
    for (const [key, entry, code] of cases) {
      const s = goodSnapshot();
      lockOf(s).packages[key] = entry;
      assert.ok(codes(checkLockfile(s)).includes(code), key);
      assert.deepEqual(codes(checkLockfile(s)).filter((c) => c !== code), key === 'dirdep@1.0.0' || key === 'gitdep@1.0.0' ? ['E_LOCK_INTEGRITY'] : [], key);
    }
  });

  it('refuses importer dependencies that are not registry packages or @bot/* workspace links', () => {
    const cases: Array<[string, string, string, string]> = [
      ['packages/engine', 'filedep', 'file:../outside', 'E_LOCK_SOURCE'],
      ['packages/engine', 'gitdep', 'git+ssh://git@github.com/x/bot.git#abc', 'E_LOCK_SOURCE'],
      ['packages/engine', 'tgz', 'https://example.com/x.tgz', 'E_LOCK_SOURCE'],
      ['packages/engine', 'plainlink', 'link:../venue', 'E_LOCK_SOURCE'],
      ['packages/engine', '@bot/badlink', 'link:../../outside', 'E_LOCK_SOURCE'],
      ['packages/engine', '@bot/named', 'link:../types', 'E_LOCK_SOURCE'],
      ['packages/engine', '@bot/types-registry', '1.0.0', 'E_INTERNAL_NOT_LINKED'],
    ];
    for (const [importer, name, version, code] of cases) {
      const s = goodSnapshot();
      addDep(lockOf(s), importer, name, version);
      assert.ok(codes(checkLockfile(s)).includes(code), `${name} ${version}`);
    }
  });

  it('reports missing workspace packages and a link to a workspace without an importer', () => {
    const s = goodSnapshot();
    s.manifests = s.manifests.filter((m) => m.json.name !== '@bot/sentinel');
    assert.deepEqual(codes(checkLockfile(s)), ['E_LOCK_IMPORTER', 'E_PACKAGE_MISSING']);
    s.manifests = s.manifests.filter((m) => m.dir === '');
    assert.deepEqual(checkLockfile(s).filter((f) => f.code === 'E_PACKAGE_MISSING').map((f) => f.message), ['@bot/types', '@bot/signer', '@bot/decoders', '@bot/engine', '@bot/signer', '@bot/sentinel']
      .map((n) => `workspace package ${n} is missing`));
    const t = goodSnapshot();
    const venue = lockOf(t).importers['packages/venue'];
    delete lockOf(t).importers['packages/venue'];
    lockOf(t).importers['packages/venue-moved'] = venue ?? {};
    assert.deepEqual(codes(checkLockfile(t)), ['E_LOCK_IMPORTER', 'E_LOCK_UNRESOLVED']);
  });

  it('refuses any third-party package in the production closure of @bot/types and @bot/signer', () => {
    const s = goodSnapshot();
    addDep(lockOf(s), 'packages/types', '@solana/kit', '8.4.0');
    const findings = checkLockfile(s);
    assert.deepEqual(codes(findings), ['E_THIRD_PARTY_RUNTIME']);
    assert.ok(findings.some((f) => f.message.includes('@bot/signer')), 'the signer reaches it through @bot/types');
  });

  it('refuses @solana/web3.js reached transitively from the engine', () => {
    const s = goodSnapshot();
    lockOf(s).snapshots['@solana/kit@8.4.0'] = { dependencies: { '@solana/addresses': '8.4.0', '@solana/web3.js': '1.98.4' } };
    addPackage(lockOf(s), '@solana/web3.js@1.98.4');
    assert.deepEqual(codes(checkLockfile(s)), ['E_WEB3_BANNED']);
  });

  it('an npm alias of compromised @solana/web3.js inside the engine closure is refused (C01 red-team M1)', () => {
    const s = goodSnapshot();
    lockOf(s).snapshots['@solana/kit@8.4.0'] = { dependencies: { '@solana/addresses': '8.4.0', '@solana/rpc-legacy': '@solana/web3.js@1.95.6' } };
    addPackage(lockOf(s), '@solana/web3.js@1.95.6');
    const findings = checkLockfile(s);
    assert.deepEqual(codes(findings), ['E_WEB3_BANNED']);
    assert.match(findings[0]?.message ?? '', /@bot\/engine/);
  });

  it('a genuine name whose package entry is missing is refused (C01 red-team M1: a tarball of another package)', () => {
    const s = goodSnapshot();
    delete lockOf(s).packages['@solana/addresses@8.4.0'];
    lockOf(s).packages['bs58-encrypt-utils@1.0.3'] = registry();
    assert.deepEqual(codes(checkLockfile(s)), ['E_LOCK_UNRESOLVED']);
  });

  it('names an aliased package in the zero-dependency closure by its real name', () => {
    const s = goodSnapshot();
    addDep(lockOf(s), 'packages/types', 'helper', 'left-pad@1.0.0');
    addPackage(lockOf(s), 'left-pad@1.0.0');
    assert.ok(checkLockfile(s).some((f) => f.code === 'E_THIRD_PARTY_RUNTIME' && f.message.endsWith('left-pad@1.0.0')));
  });

  it('allows the sentinel only internal packages and @solana/kit, also through internal packages', () => {
    const s = goodSnapshot();
    addDep(lockOf(s), 'packages/venue', 'axios', '1.0.0');
    addPackage(lockOf(s), 'axios@1.0.0');
    assert.deepEqual(codes(checkLockfile(s)), ['E_SENTINEL_DEP']);
    const t = goodSnapshot();
    addDep(lockOf(t), 'packages/sentinel', 'dev-only', '1.0.0', 'devDependencies');
    addPackage(lockOf(t), 'dev-only@1.0.0');
    assert.deepEqual(checkLockfile(t), [], 'a dev dependency is not part of the sentinel at run time');
    const u = goodSnapshot();
    addDep(lockOf(u), 'packages/sentinel', '@solana/kit', 'axios@1.0.0');
    addPackage(lockOf(u), 'axios@1.0.0');
    assert.deepEqual(codes(checkLockfile(u)), ['E_SENTINEL_DEP'], '"@solana/kit" installed as an alias of another package');
    assert.match(checkLockfile(u)[0]?.message ?? '', /axios \(installed as @solana\/kit\)/);
  });
});

describe('checkManifests', () => {
  it('passes the good fixture', () => {
    assert.deepEqual(checkManifests(goodSnapshot()), []);
  });

  it('requires exact pins in every dependency field', () => {
    for (const spec of ['^6.0.3', '~6.0.3', '6.x', 'latest', '*', '>=6', 'github:x/y', 'file:../x', 'npm:typescript@6.0.3', '6.0.3+build', 'workspace:*', 'link:../x', 'catalog:']) {
      const s = goodSnapshot();
      manifest(s, 'fixture').json.devDependencies = { typescript: spec };
      assert.deepEqual(codes(checkManifests(s)), ['E_PIN'], spec);
    }
    const s = goodSnapshot();
    manifest(s, 'fixture').json.devDependencies = { typescript: '6.0.3-beta.1' };
    assert.deepEqual(checkManifests(s), []);
  });

  it('references internal packages only through the workspace protocol (pnpm would otherwise fetch the npm @bot scope)', () => {
    for (const spec of ['1.0.0', 'workspace:^', 'workspace:1.0.0', 'link:../types', 'file:../types', 'npm:@bot/types@1.0.0']) {
      const s = goodSnapshot();
      manifest(s, '@bot/engine').json.dependencies = { '@bot/types': spec };
      assert.deepEqual(codes(checkManifests(s)), ['E_INTERNAL_NOT_LINKED'], spec);
    }
  });

  it('refuses scripts a package manager runs during install', () => {
    for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'dependencies', 'pnpm:devPreinstall']) {
      const s = goodSnapshot();
      manifest(s, '@bot/engine').json.scripts = { [script]: 'node evil.js', test: 'node --test' };
      assert.deepEqual(codes(checkManifests(s)), ['E_LIFECYCLE_SCRIPT'], script);
    }
  });

  it('refuses bundled dependencies', () => {
    for (const field of ['bundleDependencies', 'bundledDependencies'] as const) {
      const s = goodSnapshot();
      manifest(s, '@bot/engine').json[field] = ['x'];
      assert.deepEqual(codes(checkManifests(s)), ['E_BUNDLED']);
    }
  });

  it('keeps @bot/types free of runtime dependencies, internal ones included', () => {
    const s = goodSnapshot();
    manifest(s, '@bot/types').json.dependencies = { '@bot/venue': 'workspace:*' };
    assert.deepEqual(codes(checkManifests(s)), ['E_THIRD_PARTY_RUNTIME']);
  });

  it('keeps @bot/signer free of third-party runtime dependencies (dev dependencies are not runtime)', () => {
    const s = goodSnapshot();
    manifest(s, '@bot/signer').json.peerDependencies = { 'left-pad': '1.3.0' };
    assert.deepEqual(codes(checkManifests(s)), ['E_THIRD_PARTY_RUNTIME']);
    const t = goodSnapshot();
    manifest(t, '@bot/signer').json.devDependencies = { typescript: '6.0.3' };
    assert.deepEqual(checkManifests(t), []);
  });

  it('allows the sentinel only internal packages and @solana/kit', () => {
    const s = goodSnapshot();
    manifest(s, '@bot/sentinel').json.optionalDependencies = { ws: '8.0.0' };
    assert.deepEqual(codes(checkManifests(s)), ['E_SENTINEL_DEP']);
  });

  it('bans @solana/web3.js in any dependency field of the engine and the signer', () => {
    for (const [name, field] of [['@bot/engine', 'devDependencies'], ['@bot/signer', 'peerDependencies'], ['@bot/engine', 'dependencies']] as const) {
      const s = goodSnapshot();
      manifest(s, name).json[field] = { ...manifest(s, name).json[field], '@solana/web3.js': '1.98.4' };
      assert.ok(codes(checkManifests(s)).includes('E_WEB3_BANNED'), `${name} ${field}`);
    }
  });

  it('bans an npm: alias of @solana/web3.js in the engine and the signer (C01 red-team M1)', () => {
    const s = goodSnapshot();
    manifest(s, '@bot/engine').json.dependencies = { ...manifest(s, '@bot/engine').json.dependencies, legacy: 'npm:@solana/web3.js@1.98.4' };
    assert.deepEqual(codes(checkManifests(s)), ['E_PIN', 'E_WEB3_BANNED']);
  });

  it('names a manifest without a name by its file', () => {
    const s = goodSnapshot();
    s.manifests.push({ file: 'packages/anon/package.json', dir: 'packages/anon', json: { dependencies: { a: '^1' } } });
    assert.deepEqual(checkManifests(s).map((f) => f.file), ['packages/anon/package.json']);
  });
});
