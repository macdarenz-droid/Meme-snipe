// Unit tests: the freeze mechanism (B-M19-01 logic 2), the 14-day age rule, install scripts from the registry and
// lockfile drift (B-M30-01 logic 1, 3). Ported from C01; the lockfile is pnpm-lock.yaml.
import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import {
  ageExceptions, checkAges, checkInstallScripts, fetchSequential, installScriptsOf, lockIds, main as ageMain, packumentUrl, RegistryError,
  registryTimes, retryAfterMs, type HttpResponse, type Pacing, type Packument, type PublishTimes,
} from '../age.ts';
import { checkDrift, guardedFiles, guardedHash, isGuarded, reviewLabel, type GuardedFile } from '../drift.ts';
import {
  buildFreeze, changelogSection, checkFreeze, freezeFiles, freezeHash, freezeMain, rootTsconfigChain, rootTsconfigProjection, rootTypescript, semverGreater, sortedJson, tsconfigChain, writeFreeze,
} from '../freeze.ts';
import type { Git } from '../git.ts';
import { capture, codes, editJson, FIXTURES, REPO_ROOT, runBin } from './helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'policy-freeze-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const DAY = 86_400_000;
/** A registry document with these publish times and no install scripts. */
const pk = (time: PublishTimes): Packument => ({ time, installScripts: {} });

function fixtureCopy(name: string): string {
  const dir = join(tmp, name);
  cpSync(join(FIXTURES, 'good'), dir, { recursive: true });
  return dir;
}

function fakeGit(base: Record<string, string> | null): Git {
  return {
    listFiles: () => [],
    symlinks: () => [],
    submodules: () => [],
    hasRef: () => base !== null,
    show: (_ref, path) => base?.[path] ?? null,
    blob: (_ref, path) => (base?.[path] === undefined ? null : Buffer.from(base[path] as string)),
    files: () => Object.keys(base ?? {}),
    changedSince: () => [],
    mergeBase: () => (base === null ? null : 'merge-base'),
    addedLines: () => new Map(),
    changedFiles: () => [],
  };
}

/** A fake clock and sleep: sleeping advances the clock; every call is recorded. */
function fakePacing(): Pacing & { t: number; sleeps: number[] } {
  const p = { t: 1_000_000, sleeps: [] as number[], nowMs: () => p.t, sleep: async (ms: number) => { p.sleeps.push(ms); p.t += ms; } };
  return p;
}

const response = (status: number, body: string, headers: Record<string, string> = {}): HttpResponse =>
  ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body });

describe('freeze manifest', () => {
  it('hashes package.json and every file under src/, nested directories included', () => {
    const dir = fixtureCopy('hash');
    mkdirSync(join(dir, 'packages/types/src/deep'), { recursive: true });
    writeFileSync(join(dir, 'packages/types/src/deep/b.ts'), 'export {};\n');
    assert.deepEqual(freezeFiles(dir, 'packages/types'), ['package.json', 'src/deep/b.ts', 'src/index.ts']);
    assert.deepEqual(freezeFiles(dir, 'packages/signer'), ['package.json']);
    const before = freezeHash(dir, 'packages/types', freezeFiles(dir, 'packages/types'));
    writeFileSync(join(dir, 'packages/types/src/deep/b.ts'), 'export {}; \n');
    assert.notEqual(freezeHash(dir, 'packages/types', freezeFiles(dir, 'packages/types')), before);
  });

  it('freezes the package\'s tsconfig.json and every config it extends (red team RT-06)', () => {
    const dir = fixtureCopy('tsconfig');
    writeFileSync(join(dir, 'tsconfig.bot.json'), '{ "compilerOptions": { "strict": true } }\n');
    writeFileSync(join(dir, 'tsconfig.shared.json'), '{ "extends": "./tsconfig.bot.json" }\n');
    writeFileSync(join(dir, 'packages/types/tsconfig.json'), '{ "extends": "../../tsconfig.shared.json", "include": ["src/**/*.ts"] }\n');
    assert.deepEqual(tsconfigChain(dir, 'packages/types'), ['tsconfig.json', '../../tsconfig.shared.json', '../../tsconfig.bot.json']);
    assert.deepEqual(freezeFiles(dir, 'packages/types'),
      ['package.json', 'src/index.ts', 'tsconfig.json', '../../tsconfig.shared.json', '../../tsconfig.bot.json']);
    const before = freezeHash(dir, 'packages/types', freezeFiles(dir, 'packages/types'));
    writeFileSync(join(dir, 'tsconfig.bot.json'), '{ "compilerOptions": { "strict": false } }\n');
    assert.notEqual(freezeHash(dir, 'packages/types', freezeFiles(dir, 'packages/types')), before, 'a shared compiler option is part of the frozen surface');
    // A package name in `extends` is a dependency, which a frozen zero-dependency package cannot have: not followed.
    writeFileSync(join(dir, 'packages/types/tsconfig.json'), '{ "extends": "@tsconfig/node22/tsconfig.json" }\n');
    assert.deepEqual(tsconfigChain(dir, 'packages/types'), ['tsconfig.json']);
    writeFileSync(join(dir, 'packages/types/tsconfig.json'), '{ "extends": "./tsconfig.json" }\n');
    assert.deepEqual(tsconfigChain(dir, 'packages/types'), ['tsconfig.json'], 'a cycle ends');
    writeFileSync(join(dir, 'packages/types/tsconfig.json'), '{ not json\n');
    assert.deepEqual(tsconfigChain(dir, 'packages/types'), ['tsconfig.json'], 'an unreadable config is still frozen');
    assert.deepEqual(tsconfigChain(dir, 'packages/signer'), [], 'no tsconfig.json, nothing to follow');
  });

  it('follows an array extends entry by entry, and freezes the root tsconfig.json chain (red team RT2-06, ruling 3.5)', () => {
    const dir = fixtureCopy('tsconfig-root');
    writeFileSync(join(dir, 'tsconfig.bot.json'), '{ "compilerOptions": { "strict": true } }\n');
    writeFileSync(join(dir, 'tsconfig.strict.json'), '{ "compilerOptions": { "exactOptionalPropertyTypes": true } }\n');
    writeFileSync(join(dir, 'tsconfig.lib.json'), '{ "extends": "./tsconfig.bot.json" }\n');
    writeFileSync(join(dir, 'packages/types/tsconfig.json'), '{ "extends": ["../../tsconfig.lib.json", "../../tsconfig.strict.json"] }\n');
    assert.deepEqual(tsconfigChain(dir, 'packages/types'), ['tsconfig.json', '../../tsconfig.lib.json', '../../tsconfig.bot.json', '../../tsconfig.strict.json'],
      'every entry of the array, depth first');
    assert.deepEqual(rootTsconfigChain(dir, 'packages/types'), [], 'no root tsconfig.json');
    writeFileSync(join(dir, 'tsconfig.json'), '{ "extends": ["./tsconfig.bot.json", "./tsconfig.strict.json"], "include": ["packages/types/src/**/*.ts"] }\n');
    assert.deepEqual(rootTsconfigChain(dir, 'packages/types'), ['../../tsconfig.json', '../../tsconfig.bot.json', '../../tsconfig.strict.json']);
    assert.deepEqual(freezeFiles(dir, 'packages/types'), ['package.json', 'src/index.ts', 'tsconfig.json', '../../tsconfig.lib.json', '../../tsconfig.bot.json',
      '../../tsconfig.strict.json', '../../tsconfig.json'], 'each file once');
    const before = freezeHash(dir, 'packages/types', freezeFiles(dir, 'packages/types'));
    writeFileSync(join(dir, 'tsconfig.json'), '{ "extends": ["./tsconfig.bot.json", "./tsconfig.strict.json"], "include": ["packages/types/src/**/*.ts"], "compilerOptions": { "strict": false } }\n');
    assert.notEqual(freezeHash(dir, 'packages/types', freezeFiles(dir, 'packages/types')), before, 'the root tsconfig.json is part of the frozen surface');
    writeFileSync(join(dir, 'tsconfig.strict.json'), '{ "compilerOptions": { "exactOptionalPropertyTypes": false } }\n');
    const recorded = writeFreeze(dir, 'packages/types');
    writeFileSync(join(dir, 'tsconfig.strict.json'), '{ "compilerOptions": { "exactOptionalPropertyTypes": true } }\n');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], fakeGit({ 'packages/types/FREEZE.json': JSON.stringify(recorded) }), 'base')),
      ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED'], 'a config reached only through an array extends counts');
  });

  it('freezes the root tsconfig.json\'s compilerOptions and extends only, not include/exclude/files/references (round 4 ruling)', () => {
    const dir = fixtureCopy('tsconfig-root-projection');
    writeFileSync(join(dir, 'tsconfig.bot.json'), '{ "compilerOptions": { "strict": true } }\n');
    writeFileSync(join(dir, 'tsconfig.other.json'), '{ "compilerOptions": { "strict": true } }\n');
    writeFileSync(join(dir, 'packages/types/tsconfig.json'), '{ "include": ["src/**/*.ts"] }\n');
    const rootConfig = (o: Record<string, unknown>): void => writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify(o, null, 2)}\n`);
    const base = { extends: './tsconfig.bot.json', compilerOptions: { noEmit: true, types: ['node'] }, include: ['packages/types/src/**/*.ts'] };
    rootConfig(base);
    const recorded = writeFreeze(dir, 'packages/types');
    assert.ok(recorded.files.includes('../../tsconfig.json'));
    const git = fakeGit({ 'packages/types/FREEZE.json': JSON.stringify(recorded) });
    const check = (o: Record<string, unknown>): string[] => { rootConfig(o); return codes(checkFreeze(dir, ['packages/types'], git, 'base')); };
    // Not frozen: what the root config compiles, and how it is laid out.
    assert.deepEqual(check({ ...base, include: [...base.include, 'packages/engine/src/**/*.ts'] }), [], 'an added include entry');
    assert.deepEqual(check({ ...base, exclude: ['node_modules'], files: ['x.ts'], references: [{ path: './packages/engine' }] }), [], 'exclude, files, references');
    assert.deepEqual(check({ include: base.include, compilerOptions: { types: ['node'], noEmit: true }, extends: base.extends }), [], 'key order');
    // Frozen: every compiler option and the extends chain.
    assert.deepEqual(check({ ...base, compilerOptions: { ...base.compilerOptions, noEmit: false } }), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED'], 'a changed key');
    assert.deepEqual(check({ ...base, compilerOptions: { ...base.compilerOptions, strict: false } }), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED'], 'an added key');
    assert.deepEqual(check({ ...base, compilerOptions: { ...base.compilerOptions, types: ['node', 'x'] } }), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED'], 'a nested value');
    assert.deepEqual(check({ ...base, extends: './tsconfig.other.json' }), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED'], 'a changed extends target, same content');
    assert.deepEqual(check({ ...base, extends: ['./tsconfig.bot.json', './tsconfig.other.json'] }), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED'], 'an extends array');
    rootConfig(base);
    writeFileSync(join(dir, 'tsconfig.bot.json'), '{ "compilerOptions": { "strict": false } }\n');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], git, 'base')), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED'], 'an extended config is frozen whole');
    writeFileSync(join(dir, 'tsconfig.bot.json'), '{ "compilerOptions": { "strict": true } }\n');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], git, 'base')), []);
    writeFileSync(join(dir, 'packages/types/tsconfig.json'), '{ "include": ["src/**/*.ts", "test/**/*.ts"] }\n');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], git, 'base')), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED'], 'the package tsconfig stays frozen whole');
    assert.equal(rootTsconfigProjection('{ not json'), '{ not json', 'an unreadable root config is hashed whole');
    assert.equal(sortedJson({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
  });

  it('records the root TypeScript version; a different compiler is a change to the frozen surface (RT3-06, ruling 5.6)', () => {
    const dir = fixtureCopy('typescript-version');
    const recorded = writeFreeze(dir, 'packages/types');
    assert.equal(recorded.typescript, '6.0.3', 'the root devDependency');
    assert.equal(rootTypescript(dir), '6.0.3');
    const git = fakeGit({ 'packages/types/FREEZE.json': JSON.stringify(recorded) });
    assert.deepEqual(checkFreeze(dir, ['packages/types'], git, 'base'), []);
    editJson(dir, 'package.json', (p) => { (p['devDependencies'] as Record<string, string>)['typescript'] = '6.0.4'; });
    const f = checkFreeze(dir, ['packages/types'], git, 'base');
    assert.deepEqual(codes(f), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED']);
    assert.match(f.find((x) => x.code === 'E_FROZEN_CHANGED')?.message ?? '', /frozen with TypeScript 6\.0\.3; the root now declares 6\.0\.4/);
    writeFreeze(dir, 'packages/types');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], git, 'base')), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF'], 're-recorded, the base still had the old compiler');
    const unrecorded = fakeGit({ 'packages/types/FREEZE.json': JSON.stringify({ ...recorded, typescript: undefined }) });
    writeFileSync(join(dir, 'packages/types/FREEZE.json'), JSON.stringify({ ...recorded, typescript: undefined }));
    assert.ok(codes(checkFreeze(dir, ['packages/types'], unrecorded, 'base')).includes('E_FROZEN_CHANGED'), 'a FREEZE.json without the version fails');
    assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, 'packages/types/FREEZE.json'), 'utf8')).typescript, rootTypescript(REPO_ROOT));
  });

  it('freezes this repository\'s root tsconfig.json for @bot/types (ruling 3.5)', () => {
    const files = freezeFiles(REPO_ROOT, 'packages/types');
    assert.ok(files.includes('../../tsconfig.json') && files.includes('../../tsconfig.bot.json') && files.includes('tsconfig.json'), files.join(', '));
    const recorded = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/types/FREEZE.json'), 'utf8')) as { files: string[] };
    assert.deepEqual(recorded.files, files);
  });

  it('a change to a frozen package\'s tsconfig needs a bump, a changelog entry and both sign-offs (red team RT-06)', () => {
    const dir = fixtureCopy('tsconfig-bump');
    writeFileSync(join(dir, 'packages/types/tsconfig.json'), '{ "include": ["src/**/*.ts"] }\n');
    const recorded = writeFreeze(dir, 'packages/types');
    assert.ok(recorded.files.includes('tsconfig.json'));
    const base = fakeGit({ 'packages/types/FREEZE.json': JSON.stringify(recorded) });
    assert.deepEqual(checkFreeze(dir, ['packages/types'], base, 'base'), []);
    writeFileSync(join(dir, 'packages/types/tsconfig.json'), '{ "include": ["src/**/*.ts", "test/**/*.ts"] }\n');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], base, 'base')), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF', 'E_FROZEN_CHANGED']);
    writeFreeze(dir, 'packages/types');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], base, 'base')), ['E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF']);
  });

  it('records the package name, version, hash and files', () => {
    const dir = fixtureCopy('build');
    const m = buildFreeze(dir, 'packages/types');
    assert.equal(m.package, '@bot/types');
    assert.equal(m.version, '1.0.0');
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(readFileSync(join(FIXTURES, 'good/packages/types/FREEZE.json'), 'utf8')), m);
  });

  it('finds a changelog section with or without a date, up to the next section', () => {
    const md = '# C\n\n## 1.1.0 — 2026-10-07\n\nnew\n\n## 1.0.0\n\nold\n';
    assert.equal(changelogSection(md, '1.1.0'), '\nnew\n');
    assert.equal(changelogSection(md, '1.0.0'), '\nold\n');
    assert.equal(changelogSection(md, '1.0'), null);
    assert.equal(changelogSection(md, '2.0.0'), null);
  });

  it('compares plain semantic versions', () => {
    assert.equal(semverGreater('2.0.0', '1.9.9'), true);
    assert.equal(semverGreater('1.1.0', '1.0.9'), true);
    assert.equal(semverGreater('1.0.1', '1.0.0'), true);
    assert.equal(semverGreater('1.0.0', '1.0.0'), false);
    assert.equal(semverGreater('1.0.0', '1.0.1'), false);
    assert.equal(semverGreater('1.0.0-rc.1', '0.9.0'), false);
    assert.equal(semverGreater('1.0.0', 'x'), false);
  });

  it('CLI: records FREEZE.json, or explains its usage', () => {
    const dir = fixtureCopy('cli');
    writeFileSync(join(dir, 'packages/types/src/index.ts'), 'export type Fixture = 2;\n');
    const io = capture();
    assert.equal(freezeMain([], dir, io), 2);
    assert.equal(freezeMain(['packages/types'], dir, io), 0);
    assert.match(io.text(), /usage[\s\S]*@bot\/types 1\.0\.0 [0-9a-f]{64}/);
    assert.equal(runBin('freeze.ts', [], dir).status, 2);
    assert.equal(runBin('freeze.ts', ['packages/types'], dir).status, 0);
  });
});

describe('checkFreeze', () => {
  const good = readFileSync(join(FIXTURES, 'good/packages/types/FREEZE.json'), 'utf8');

  it('passes when the files match FREEZE.json and the base has the same freeze, or none', () => {
    const dir = fixtureCopy('pass');
    assert.deepEqual(checkFreeze(dir, ['packages/types'], fakeGit({ 'packages/types/FREEZE.json': good }), 'base'), []);
    assert.deepEqual(checkFreeze(dir, ['packages/types'], fakeGit({}), 'base'), []);
  });

  it('fails closed without the base ref, but still checks the files', () => {
    const dir = fixtureCopy('nobase');
    writeFileSync(join(dir, 'packages/types/src/index.ts'), 'export type Fixture = 3;\n');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], fakeGit(null), 'base')), ['E_BASE_REF', 'E_FROZEN_CHANGED']);
  });

  it('requires a valid FREEZE.json', () => {
    const dir = fixtureCopy('nofreeze');
    rmSync(join(dir, 'packages/types/FREEZE.json'));
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], fakeGit({}), 'base')), ['E_FREEZE_MISSING']);
    writeFileSync(join(dir, 'packages/types/FREEZE.json'), '{"version": "1.0.0"}');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], fakeGit({}), 'base')), ['E_FREEZE_MISSING']);
    writeFileSync(join(dir, 'packages/types/FREEZE.json'), 'not json');
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], fakeGit({}), 'base')), ['E_FREEZE_MISSING']);
  });

  it('requires the recorded version to be the package version, with a changelog section', () => {
    const dir = fixtureCopy('version');
    const pkg = join(dir, 'packages/types/package.json');
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.0.0"', '"1.0.1"'));
    rmSync(join(dir, 'packages/types/CHANGELOG.md'));
    assert.deepEqual(codes(checkFreeze(dir, ['packages/types'], fakeGit({}), 'base')), ['E_CHANGELOG', 'E_FREEZE_VERSION', 'E_FROZEN_CHANGED']);
  });

  it('ignores an unreadable base FREEZE.json (first freeze)', () => {
    const dir = fixtureCopy('badbase');
    assert.deepEqual(checkFreeze(dir, ['packages/types'], fakeGit({ 'packages/types/FREEZE.json': '{' }), 'base'), []);
  });

  it('a re-recorded change without a changelog section needs a bump and both sign-offs', () => {
    const dir = fixtureCopy('unsigned');
    writeFileSync(join(dir, 'packages/types/src/index.ts'), 'export type Fixture = 4;\n');
    const pkg = join(dir, 'packages/types/package.json');
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.0.0"', '"0.9.0"'));
    writeFreeze(dir, 'packages/types');
    const findings = checkFreeze(dir, ['packages/types'], fakeGit({ 'packages/types/FREEZE.json': good }), 'base');
    assert.deepEqual(codes(findings), ['E_CHANGELOG', 'E_FREEZE_BUMP', 'E_FREEZE_SIGNOFF']);
    assert.equal(findings.filter((f) => f.code === 'E_FREEZE_SIGNOFF').length, 2);
  });

  it('counts a sign-off only with a name that is not "pending"', () => {
    const dir = fixtureCopy('signoff');
    writeFileSync(join(dir, 'packages/types/src/index.ts'), 'export type Fixture = 5;\n');
    const pkg = join(dir, 'packages/types/package.json');
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.0.0"', '"1.0.1"'));
    writeFreeze(dir, 'packages/types');
    const check = (lines: string): string[] => {
      writeFileSync(join(dir, 'packages/types/CHANGELOG.md'), `# C\n\n## 1.0.1\n\n${lines}\n`);
      return checkFreeze(dir, ['packages/types'], fakeGit({ 'packages/types/FREEZE.json': good }), 'base').map((f) => f.message.slice(-30));
    };
    assert.equal(check('Sign-off (group A lead):\nSign-off (group B lead): Pending until review').length, 2);
    assert.equal(check('Sign-off (group A lead): Ann\nnot a sign-off\nSign-off (group B lead):   ').length, 1);
    assert.equal(check('Sign-off (group A lead): Ann\nSign-off (group B lead): Bo').length, 0);
  });
});

describe('dependency age (14 days)', () => {
  const now = Date.parse('2026-10-06T00:00:00Z');
  const times: Map<string, PublishTimes> = new Map([
    ['old', { '1.0.0': '2026-09-01T00:00:00Z' }],
    ['edge', { '1.0.0': new Date(now - 14 * DAY).toISOString() }],
    ['new', { '1.0.0': '2026-10-01T00:00:00Z' }],
    ['weird', { '1.0.0': 'not a date' }],
  ]);

  it('accepts versions at least 14 days old and refuses newer or unknown ones', () => {
    const entries = [{ name: 'old', version: '1.0.0' }, { name: 'edge', version: '1.0.0' }, { name: 'new', version: '1.0.0' },
      { name: 'weird', version: '1.0.0' }, { name: 'old', version: '2.0.0' }, { name: 'absent', version: '1.0.0' }];
    const findings = checkAges(entries, times, new Set(), now);
    assert.deepEqual(findings.map((f) => `${f.code} ${f.message.split(':')[0]?.split(' ')[0]}`), [
      'E_TOO_NEW new@1.0.0', 'E_AGE_UNKNOWN weird@1.0.0', 'E_AGE_UNKNOWN old@2.0.0', 'E_AGE_UNKNOWN absent@1.0.0',
    ]);
    assert.deepEqual(checkAges([{ name: 'new', version: '1.0.0' }], times, new Set(['new@1.0.0']), now), []);
  });

  it('reads reviewed exceptions and refuses incomplete rows', () => {
    const md = '| Package | Reason | Reviewer |\n|---|---|---|\n| `new@1.0.0` | GHSA-x fix | Sup |\n| `@s/p@2.0.0-rc.1` | fix | Sup |\n| `nover` | fix | Sup |\n| `x@1.0.0` |  | Sup |\n';
    const { ids, findings } = ageExceptions(md);
    assert.deepEqual([...ids], ['new@1.0.0', '@s/p@2.0.0-rc.1']);
    assert.deepEqual(findings.map((f) => f.file), ['DEPENDENCIES.md:5', 'DEPENDENCIES.md:6']);
    assert.deepEqual(ageExceptions('no table').ids.size, 0);
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    assert.equal(retryAfterMs(null, 0), null);
    assert.equal(retryAfterMs(' 120 ', 0), 120_000);
    assert.equal(retryAfterMs('Tue, 06 Oct 2026 00:00:30 GMT', Date.parse('2026-10-06T00:00:00Z')), 30_000);
    assert.equal(retryAfterMs('Tue, 06 Oct 2026 00:00:00 GMT', Date.parse('2026-10-06T00:01:00Z')), 0);
    assert.equal(retryAfterMs('soon', 0), null);
  });

  it('asks the registry for the full packument, scoped names escaped as npm does', async () => {
    assert.equal(packumentUrl('@solana/kit'), 'https://registry.npmjs.org/@solana%2Fkit');
    assert.equal(packumentUrl('typescript'), 'https://registry.npmjs.org/typescript');
    const urls: string[] = [];
    const ok = registryTimes(async (url) => { urls.push(url); return response(200, JSON.stringify({ time: { '1.0.0': '2026-01-01T00:00:00Z', created: 5 } })); }, () => 0);
    assert.deepEqual(await ok('@s/p'), pk({ '1.0.0': '2026-01-01T00:00:00Z' }));
    assert.deepEqual(urls, ['https://registry.npmjs.org/@s%2Fp']);
  });

  it('classifies registry failures: 429, 403, 5xx and network errors may be retried; others stop the run', async () => {
    const fail = async (get: () => Promise<HttpResponse>): Promise<RegistryError> => {
      try { await registryTimes(get, () => 0)('p'); } catch (e) { return e as RegistryError; }
      throw new Error('expected a failure');
    };
    const limited = await fail(async () => response(429, '', { 'retry-after': '7' }));
    assert.deepEqual([limited.retryable, limited.retryAfterMs, limited.message], [true, 7000, 'registry answered 429 for p']);
    assert.equal((await fail(async () => response(403, ''))).retryable, true);
    assert.equal((await fail(async () => response(503, ''))).retryable, true);
    assert.equal((await fail(async () => response(404, ''))).retryable, false);
    assert.equal((await fail(async () => { throw new Error('ECONNRESET'); })).retryable, true);
    assert.match((await fail(async () => response(200, '{'))).message, /not JSON/);
    assert.match((await fail(async () => response(200, '{"time":"x"}'))).message, /no publish times/);
    assert.match((await fail(async () => response(200, 'null'))).message, /no publish times/);
  });

  it('keeps one request in flight, at least 500 ms apart (C01 red-team M4)', async () => {
    const pacing = fakePacing();
    let inFlight = 0;
    let max = 0;
    const starts: number[] = [];
    const fetchTimes = async (name: string): Promise<Packument> => {
      inFlight++; max = Math.max(max, inFlight); starts.push(pacing.t);
      await new Promise((r) => { setImmediate(r); });
      pacing.t += 100;
      inFlight--;
      return pk({ [name]: 'x' });
    };
    const got = await fetchSequential(['a', 'b', 'c'], fetchTimes, pacing);
    assert.deepEqual([...got.keys()], ['a', 'b', 'c']);
    assert.equal(max, 1);
    assert.deepEqual(starts.map((t, i) => (i === 0 ? 0 : t - (starts[i - 1] as number))), [0, 500, 500]);
  });

  it('backs off exponentially, honours a longer Retry-After, and stops at the third failure of the run (C01 red-team M4)', async () => {
    const pacing = fakePacing();
    let calls = 0;
    const flaky = async (): Promise<Packument> => { calls++; throw new RegistryError('429', true, calls === 2 ? 10_000 : null); };
    await assert.rejects(fetchSequential(['a', 'b'], flaky, pacing), /429/);
    assert.equal(calls, 3, 'stops after 3 failures');
    assert.deepEqual(pacing.sleeps.filter((ms) => ms > 500), [2000, 10_000], 'backoff 2 s, then Retry-After 10 s over the 4 s backoff');
    const p2 = fakePacing();
    let n = 0;
    const twice = async (name: string): Promise<Packument> => { n++; if (n <= 2) throw new RegistryError('503', true, null); return pk({ [name]: 'x' }); };
    assert.deepEqual([...(await fetchSequential(['a'], twice, p2)).keys()], ['a']);
    assert.deepEqual(p2.sleeps.filter((ms) => ms > 500), [2000, 4000], 'exponential: 2 s, 4 s');
  });

  it('aborts everything at once on a failure that may not be retried, or a Retry-After over two minutes (C01 red-team M4)', async () => {
    let calls = 0;
    const fatal = async (name: string): Promise<Packument> => { calls++; if (name === 'p0') throw new RegistryError('404', false, null); return pk({}); };
    await assert.rejects(fetchSequential(['p0', 'p1', 'p2'], fatal, fakePacing()), /404/);
    assert.equal(calls, 1, 'no request after the fatal failure');
    await assert.rejects(fetchSequential(['a'], async () => { throw new Error('bug'); }, fakePacing()), /bug/);
    let c2 = 0;
    await assert.rejects(fetchSequential(['a'], async () => { c2++; throw new RegistryError('429', true, 3_600_000); }, fakePacing()), /longer than 120000 ms, stopping/);
    assert.equal(c2, 1);
  });

  it('lists name@version of a lockfile text by real name, tolerating a missing or broken one', () => {
    const aliased = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      x:\n        specifier: npm:y@1.0.0\n        version: y@1.0.0\n"
      + 'packages:\n  y@1.0.0:\n    resolution: {integrity: sha512-x}\nsnapshots:\n  y@1.0.0: {}\n';
    assert.deepEqual([...lockIds(aliased)], ['y@1.0.0']);
    assert.deepEqual([...lockIds(null)], []);
    assert.deepEqual([...lockIds('a: [\n')], []);
    assert.deepEqual([...lockIds('null')], []);
  });

  it('reads each version\'s install scripts from the packument and refuses a new version that declares one', async () => {
    assert.deepEqual(installScriptsOf({
      '1.0.0': { scripts: { test: 'x', prepare: 'y' } }, '2.0.0': { scripts: { postinstall: 'x', install: 'y' } }, '2.3.3': { scripts: { install: 'node-gyp rebuild' }, gypfile: true },
      '3.0.0': { gypfile: true }, '4.0.0': null, '5.0.0': { scripts: null }, '6.0.0': { scripts: { preinstall: '' } },
    }), { '2.0.0': ['postinstall', 'install'], '2.3.3': ['install', 'gypfile'], '3.0.0': ['gypfile'], '6.0.0': ['preinstall'] });
    assert.deepEqual(installScriptsOf(null), {});
    assert.deepEqual(installScriptsOf('x'), {});
    const doc = await registryTimes(async () => response(200, JSON.stringify({ time: { '2.0.0': 'x' }, versions: { '2.0.0': { scripts: { postinstall: 'x' } } } })), () => 0)('p');
    assert.deepEqual(doc, { time: { '2.0.0': 'x' }, installScripts: { '2.0.0': ['postinstall'] } });
    const docs = new Map([['p', doc], ['q', pk({})]]);
    const findings = checkInstallScripts([{ name: 'p', version: '2.0.0' }, { name: 'p', version: '1.0.0' }, { name: 'q', version: '1.0.0' }, { name: 'absent', version: '1.0.0' }], docs);
    assert.deepEqual(findings.map((f) => `${f.code} ${f.file}: ${f.message}`), [
      'E_INSTALL_SCRIPT pnpm-lock.yaml: p@2.0.0 declares postinstall in its registry manifest; install scripts are not allowed',
    ]);
  });

  it('main: fetches only versions new against the base lockfile, by real name, and fails on a new one', async () => {
    const dir = fixtureCopy('age');
    const asked: string[] = [];
    const fetchOld = async (name: string): Promise<Packument> => { asked.push(name); return pk({ '8.4.0': '2026-09-01T00:00:00Z', '6.0.3': '2026-04-16T23:38:27Z' }); };
    const lock = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8');
    const io = capture();
    assert.equal(await ageMain(dir, now, io, fetchOld, fakeGit({}), 'base', fakePacing()), 0);
    assert.match(io.text(), /3 package version\(s\) new against base \(3 package\(s\) fetched\), each at least 14 days old, none with an install script/);
    assert.deepEqual(asked, ['@solana/addresses', '@solana/kit', 'typescript']);
    asked.length = 0;
    assert.equal(await ageMain(dir, now, capture(), fetchOld, fakeGit({ 'pnpm-lock.yaml': lock }), 'base', fakePacing()), 0);
    assert.equal(asked.length, 0, 'an unchanged lockfile makes no registry request');
    const withAlias = (target: string): string => lock
      .replace("  packages/engine:\n    dependencies:\n", `  packages/engine:\n    dependencies:\n      helper:\n        specifier: npm:${target}\n        version: ${target}\n`)
      .replace('\nsnapshots:\n', target === 'typescript@6.0.3' ? '\nsnapshots:\n' : `\n  ${target}:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n  ${target}: {}\n`);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), withAlias('typescript@6.0.3'));
    assert.equal(await ageMain(dir, now, capture(), fetchOld, fakeGit({ 'pnpm-lock.yaml': lock }), 'base', fakePacing()), 0);
    assert.equal(asked.length, 0, 'an alias of a known version is that version');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), withAlias('left-pad@1.3.0'));
    const io2 = capture();
    assert.equal(await ageMain(dir, now, io2, async (name) => { asked.push(name); return pk({ '1.3.0': '2026-10-05T00:00:00Z' }); }, fakeGit({ 'pnpm-lock.yaml': lock }), 'base', fakePacing()), 1);
    assert.deepEqual(asked, ['left-pad'], 'the real package is fetched, not the alias');
    assert.match(io2.text(), /E_TOO_NEW pnpm-lock\.yaml: left-pad@1\.3\.0/);
    const io3 = capture();
    const old = { '1.3.0': '2026-09-01T00:00:00Z' };
    assert.equal(await ageMain(dir, now, io3, async () => ({ time: old, installScripts: { '1.3.0': ['install', 'gypfile'] } }), fakeGit({ 'pnpm-lock.yaml': lock }), 'base', fakePacing()), 1);
    assert.match(io3.text(), /E_INSTALL_SCRIPT pnpm-lock\.yaml: left-pad@1\.3\.0 declares install, gypfile in its registry manifest/);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'a: [\n');
    const io4 = capture();
    assert.equal(await ageMain(dir, now, io4, fetchOld, fakeGit({ 'pnpm-lock.yaml': lock }), 'base', fakePacing()), 1);
    assert.match(io4.text(), /E_LOCK_PARSE pnpm-lock\.yaml: line 1/);
  });

  it('main: reads the base lockfile at the merge base, not at the base tip (round 1 review F5)', async () => {
    const dir = fixtureCopy('age-merge-base');
    const lock = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8');
    // The base branch moved on after this head forked: its tip no longer records @solana/kit at all. Reading the tip
    // would make every version of this lockfile "new" and fetch (and fail) on versions this change never touched.
    const tip = lock.replace(/ {2}'@solana\/kit@8\.4\.0':\n(.*\n)+?\n/, '\n');
    assert.notEqual(tip, lock);
    const refs: string[] = [];
    const asked: string[] = [];
    const git: Git = {
      ...fakeGit({}),
      mergeBase: () => 'merge-base',
      show: (ref, path) => { refs.push(`${ref}:${path}`); return ref === 'merge-base' ? lock : tip; },
    };
    const io = capture();
    assert.equal(await ageMain(dir, now, io, async (name) => { asked.push(name); return pk({}); }, git, 'origin/base', fakePacing()), 0);
    assert.deepEqual(refs, ['merge-base:pnpm-lock.yaml']);
    assert.deepEqual(asked, [], 'nothing is new against the merge base, so no request is made');
    assert.match(io.text(), /0 package version\(s\) new against origin\/base/);
    const io2 = capture();
    assert.equal(await ageMain(dir, now, io2, async () => pk({}), { ...git, mergeBase: () => null }, 'origin/base', fakePacing()), 1);
    assert.match(io2.text(), /E_BASE_REF origin\/base: no merge base between "origin\/base" and HEAD/);
  });

  it('main: fails closed without the base ref and reports a stopped fetch', async () => {
    const dir = fixtureCopy('age-fail');
    const io = capture();
    assert.equal(await ageMain(dir, now, io, async () => pk({}), fakeGit(null), 'base', fakePacing()), 1);
    assert.match(io.text(), /E_BASE_REF base/);
    const io2 = capture();
    assert.equal(await ageMain(dir, now, io2, async () => { throw new RegistryError('registry answered 404 for x', false, null); }, fakeGit({}), 'base', fakePacing()), 1);
    assert.match(io2.text(), /E_AGE_FETCH registry: registry answered 404 for x; no further requests were made/);
  });
});

describe('review label for the lockfile and policy files', () => {
  const file = (path: string, text: string): GuardedFile => ({ path, bytes: Buffer.from(text) });
  const files = [file('pnpm-lock.yaml', "lockfileVersion: '9.0'\n"), file('tools/policy/drift.ts', 'x')];

  it('guards the lockfile, pnpm-workspace.yaml, package.json, .npmrc, .node-version, vitest.config.ts, eslint.config.mjs, tsconfig*, tools/** and .github/** (C01 red-team M3)', () => {
    for (const p of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', '.npmrc', '.node-version', 'vitest.config.ts', 'eslint.config.mjs', 'tsconfig.json', 'tsconfig.base.json',
      'tsconfig.bot.json', 'packages/engine/tsconfig.json', 'tools/policy/drift.ts', 'tools/package.json', 'tools/policy/test/fixtures/good/pnpm-lock.yaml', '.github/workflows/ci.yml']) {
      assert.equal(isGuarded(p), true, p);
    }
    for (const p of ['packages/engine/src/a.ts', 'packages/engine/package.json', 'docs/ARCH.md', 'sub/pnpm-lock.yaml', 'package-lock.json', 'xtools/a.ts',
      'packages/types/src/canon.ts', 'packages/engine/CHANGELOG.md', 'docs/DEPENDENCIES.md', 'my-eslint.config.js']) {
      assert.equal(isGuarded(p), false, p);
    }
  });

  it('guards every eslint.config.* at any depth, DEPENDENCIES.md and the frozen packages\' FREEZE.json and CHANGELOG.md (C01 review R1, R3)', () => {
    for (const p of ['eslint.config.js', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts', 'packages/engine/eslint.config.js',
      'packages/signer/src/eslint.config.mjs', 'DEPENDENCIES.md', 'packages/types/FREEZE.json', 'packages/types/CHANGELOG.md']) {
      assert.equal(isGuarded(p), true, p);
    }
  });

  it('needs the label bound to every guarded file, only when a guarded file changed', () => {
    assert.deepEqual(checkDrift(['src/a.ts'], [], files), []);
    assert.deepEqual(checkDrift(['.npmrc', 'pnpm-lock.yaml'], ['other'], files).map((f) => `${f.code} ${f.file}`), ['E_LOCK_DRIFT pnpm-lock.yaml']);
    assert.deepEqual(codes(checkDrift(['tools/policy/drift.ts'], ['other'], files)), ['E_POLICY_DRIFT']);
    assert.deepEqual(checkDrift(['tools/policy/drift.ts', 'a.ts'], [reviewLabel(files)], files, reviewLabel(files)), []);
    assert.deepEqual(codes(checkDrift(['pnpm-lock.yaml'], ['deps-reviewed'], files)), ['E_LOCK_DRIFT']);
    const edited = [files[0] as GuardedFile, file('tools/policy/drift.ts', 'y')];
    assert.deepEqual(codes(checkDrift(['tools/policy/drift.ts'], [reviewLabel(files)], edited)), ['E_POLICY_DRIFT'], 'a policy edit makes the label stale');
    assert.deepEqual(codes(checkDrift(['pnpm-lock.yaml'], ['deps-reviewed'], [])), ['E_LOCK_DRIFT'], 'a removed lockfile cannot be labelled');
    const many = ['.npmrc', 'package.json', 'tools/a', 'tools/b', 'tools/c', 'tools/d', 'tools/e'];
    assert.match(checkDrift(many, [], files)[0]?.message ?? '', /^changed: \.npmrc, package\.json, tools\/a, tools\/b, tools\/c and 2 more\. .*"deps-reviewed:[0-9a-f]{32}", computed on the merge commit/);
  });

  it('counts the label only on the run whose own event added it (red team RT-03, supervisor ruling 7)', () => {
    const label = reviewLabel(files);
    assert.deepEqual(checkDrift(['pnpm-lock.yaml'], [label], files, label), [], 'the labeled event that added it');
    const stale = checkDrift(['pnpm-lock.yaml'], [label], files, '');
    assert.deepEqual(codes(stale), ['E_LOCK_DRIFT'], 'the same label on a later push run: not this run\'s event');
    assert.match(stale[0]?.message ?? '', /was not added by this run's event, so it is older than this head: remove it and add it again/);
    assert.deepEqual(codes(checkDrift(['pnpm-lock.yaml'], [label], files, 'other-label')), ['E_LOCK_DRIFT'], 'another label was added');
    assert.deepEqual(checkDrift(['src/a.ts'], [], files, ''), [], 'a push that changes no guarded file needs no label');
  });

  it('reads the guarded files of a tree, and fails closed on one it cannot read', () => {
    const git = fakeGit({ 'pnpm-lock.yaml': '{}', 'docs/a.md': 'x', '.npmrc': 'ignore-scripts=true' });
    assert.deepEqual(guardedFiles(git, 'HEAD').map((f) => `${f.path} ${f.bytes.length}`), ['pnpm-lock.yaml 2', '.npmrc 19']);
    assert.throws(() => guardedFiles({ ...git, blob: () => null }, 'HEAD'), /cannot read pnpm-lock\.yaml at HEAD/);
  });

  it('hashes path, length and bytes in path order (known vector)', () => {
    assert.equal(guardedHash([]), 'e3b0c44298fc1c149afbf4c8996fb924' + '27ae41e4649b934ca495991b7852b855');
    assert.equal(guardedHash(files), guardedHash([...files].reverse()));
    assert.notEqual(guardedHash([file('a', 'bc')]), guardedHash([file('ab', 'c')]));
    assert.equal(reviewLabel([]), 'deps-reviewed:e3b0c44298fc1c149afbf4c8996fb924');
  });
});
