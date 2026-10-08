// Unit tests: the import-graph check (C01 red-team finding M2). The attack files are the red team's repro files.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import { runChecks } from '../check.ts';
import { gitAt } from '../git.ts';
import { checkImports, checkRef, moduleRefs, packageName, urlTarget, type ModuleRef } from '../imports.ts';
import { readRepo, type Manifest, type RepoSnapshot } from '../repo.ts';
import { codes, goodRepo, goodSnapshot, REPO_ROOT } from './helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'policy-imports-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The good fixture with `files` written under a fresh root. */
function snapshotWith(files: Record<string, string>): { snapshot: RepoSnapshot; files: string[] } {
  const root = mkdtempSync(join(tmp, 'repo-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return { snapshot: { ...goodSnapshot(), root }, files: Object.keys(files) };
}

const check = (file: string, code: string): string[] => {
  const { snapshot, files } = snapshotWith({ [file]: code });
  return checkImports(snapshot, files).map((f) => f.code);
};

describe('module references', () => {
  it('finds every way a module is loaded, with its line', () => {
    const code = [
      "import a from 'a';",
      "import type { B } from 'b';",
      "export * from 'c';",
      "export { d } from 'd';",
      "const e = await import('e');",
      "const f = require('f');",
      "type G = typeof import('g');",
      "import h = require('h');",
      "module['require']('i');",
      'require(`j`);',
      "import(('k' as string)!);",
      "import('l' satisfies string);",
      "import(<string>'m');",
      'export const n = 1;',
      'require.resolve(x); x[y](z); import N = Q.R;',
    ].join('\n');
    assert.deepEqual(moduleRefs(code, 'a.ts').filter((r) => !r.loader).map((r) => `${r.kind} ${String(r.specifier)} ${r.line}`), [
      'import a 1', 'import b 2', 'export from c 3', 'export from d 4', 'import() e 5', 'require() f 6', 'import type g 7',
      'import = require() h 8', 'require() i 9', 'require() j 10', 'import() k 11', 'import() l 12', 'import() m 13',
    ]);
  });

  it('reports a computed specifier as null, and parses JSX by file extension', () => {
    assert.deepEqual(moduleRefs('import(x); require(`a${b}`); require(1); require();', 'a.ts').map((r) => r.specifier), [null, null, null, null]);
    assert.deepEqual(moduleRefs("import x from 'x';\nexport const c = <div>{x}</div>;", 'a.tsx').map((r) => r.specifier), ['x']);
    assert.throws(() => moduleRefs('const = ;', 'a.ts'));
  });

  it('names the package of a bare specifier', () => {
    assert.equal(packageName('@solana/web3.js/lib/index.js'), '@solana/web3.js');
    assert.equal(packageName('fast-check'), 'fast-check');
    assert.equal(packageName('a/b/c'), 'a');
  });
});

describe('code loaders (C01 review R2)', () => {
  const loaders = (code: string): string[] => moduleRefs(code, 'a.ts').filter((r) => r.loader).map((r) => `${r.kind} ${r.line}`);

  it('finds getBuiltinModule, dlopen, eval, Function, .constructor reads, bare require and string timers, once per kind and line', () => {
    assert.deepEqual(loaders([
      "const { createRequire } = process.getBuiltinModule('node:module');",
      "const { getBuiltinModule } = process; const g = process['getBuiltinModule'];",
      "export const f = () => new Function('s', 'return import(s)')('fast-check');",
      "(0, eval)('1'); globalThis['eval']('x'); globalThis.Function('x');",
      "(() => 1).constructor('x'); const { constructor: F } = () => 1; Reflect.get(F, `constructor`);",
      "const r = require; require.resolve('x'); x.require;",
      "setTimeout('alert(1)'); globalThis.setInterval(`x`, 1); setImmediate('a' + b); execScript('x');",
      "process.dlopen(m, '/x.node');",
    ].join('\n')), [
      'getBuiltinModule 1', 'getBuiltinModule 2', 'Function 3', 'eval 4', 'Function 4', 'constructor 5', 'require 6', 'implied eval 7', 'dlopen 8',
    ]);
  });

  it('ignores types, class constructors, require() calls, object literal keys named constructor, and timers given a function', () => {
    assert.deepEqual(loaders([
      'class A { constructor() {} }',
      'let x: Function; type T = typeof eval; interface I extends Function { constructor: Function } declare function d(f: Function): void;',
      "const o = { constructor: 1 }; const evalId = 1; require('y'); module.require('z'); import('w');",
      'setTimeout(() => 1, 5); setTimeout(fn); x.setTimeout(); clearTimeout(t); unknownCall()(1);',
      "const s = 'not eval'; const t = `getBuiltinModule ${x}`;",
    ].join('\n')), []);
  });

  it('refuses them in workspace packages, tests included, and allows them in tools/ (C01 review R2 repro)', () => {
    const repro = "const { createRequire } = process.getBuiltinModule('node:module');\nexport const fc = createRequire(import.meta.url)('fast-check');\n";
    assert.deepEqual(check('packages/signer/src/x.ts', repro), ['E_CODE_LOADING']);
    assert.deepEqual(check('packages/signer/src/y.ts', "export const f = () => new Function('s', 'return import(s)')('fast-check');\n"), ['E_CODE_LOADING']);
    assert.deepEqual(check('packages/engine/test/z.test.ts', "export const v = eval('1');\n"), ['E_CODE_LOADING']);
    assert.deepEqual(check('tools/a.ts', repro), []);
    const ref: ModuleRef = { kind: 'constructor', specifier: null, line: 2, loader: true };
    const signer: Manifest = { file: 'packages/signer/package.json', dir: 'packages/signer', json: { name: '@bot/signer' } };
    assert.equal(checkRef(ref, 'packages/signer/src/a.ts', { manifest: signer, root: undefined, test: false })?.message,
      'constructor: a .constructor read reaches the Function constructor from any function; not allowed in workspace packages, where every import must be checkable');
  });
});

describe('checkImports (C01 red-team M2)', () => {
  it('the signer cannot use an undeclared, hoisted third-party package', () => {
    assert.deepEqual(check('packages/signer/src/rt-phantom.ts',
      "// red team: the signer imports a third-party package it never declares (hoisted into the root node_modules)\nimport fc from 'fast-check';\nexport const sample = (): unknown => fc.sample(fc.nat(), 1);\n"),
    ['E_THIRD_PARTY_RUNTIME']);
  });

  it('dynamic import and createRequire of @solana/web3.js in the engine are refused', () => {
    assert.deepEqual(check('packages/engine/src/rt-web3.ts', [
      '// red team: dynamic import and createRequire are not covered by no-restricted-imports',
      "import { createRequire } from 'node:module';",
      "export async function load(): Promise<unknown> { return import('@solana/web3.js' as string); }",
      "export const req = (): unknown => createRequire(import.meta.url)('@solana/web3.js');",
    ].join('\n')), ['E_IMPORT_FORBIDDEN', 'E_WEB3_BANNED']);
  });

  it('a .js or .mts module under packages/ is refused and its imports are still checked', () => {
    const web3 = "import { Connection } from '@solana/web3.js';\nexport const c = Connection;\nexport const t = Date.now() + Math.random();\n";
    assert.deepEqual(check('packages/engine/src/rt-web3.js', web3), ['E_SOURCE_TYPE', 'E_WEB3_BANNED']);
    assert.deepEqual(check('packages/signer/src/rt-web3.mts', web3), ['E_SOURCE_TYPE', 'E_WEB3_BANNED']);
    for (const file of ['packages/engine/src/a.cjs', 'packages/engine/src/a.jsx', 'packages/engine/src/a.tsx', 'tools/a.mjs', 'packages/engine/a.node', 'tools/x.wasm']) {
      assert.deepEqual(check(file, 'export {};\n'), ['E_SOURCE_TYPE'], file);
    }
    assert.deepEqual(check('eslint.config.mjs', 'export default [];\n'), [], 'root files may be .mjs');
    assert.deepEqual(check('packages/engine/README.md', "import x from 'x'\n"), [], 'not a module');
    assert.deepEqual(check('tools/policy/test/fixtures/x/packages/engine/src/a.js', "import 'nope';\n"), [], 'fixtures are data');
    assert.deepEqual(check('packages/engine/src/broken.ts', 'const = ;\n'), ['E_IMPORT_PARSE']);
  });

  it('allows built-ins with node:, relative paths inside the package, and declared packages', () => {
    const ok = [
      ['packages/engine/src/a.ts', "import { readFileSync } from 'node:fs'; import './b.ts'; import '.'; import '..'; import '@bot/types'; import '@bot/engine';"],
      ['packages/signer/src/a.ts', "import '@bot/types'; import 'node:crypto';"],
      ['packages/engine/src/m24/a.ts', "import { DatabaseSync } from 'node:sqlite';"],
      ['packages/engine/test/m24/a.test.ts', "import 'node:sqlite';"],
      ['packages/engine/src/m24/migrate.ts', "import { schemaTx } from './schema-tx.ts';"],
      ['packages/engine/src/m24/db.ts', "import { registerSchemaRunner } from './schema-tx.ts';"],
      ['packages/engine/test/helpers.ts', "import { schemaTx } from '../src/m24/schema-tx.ts';"],
      ['packages/engine/test/m24/a.test.ts', "import { schemaFixture } from '../helpers.ts'; export * from '../helpers.ts';"],
      ['packages/engine/src/testing.ts', "import './test-data.ts'; import './testing.ts'; import './contest/x.ts'; import './latest.spec-sheet.ts';"],
      ['packages/engine/src/__tests__/a.test.ts', "import '../../test/helpers.ts'; import './b.spec.ts';"],
      ['packages/sentinel/src/a.ts', "import '@solana/kit/x'; import '@bot/venue';"],
      ['packages/signer/test/a.test.ts', "import 'typescript'; import '@bot/types'; import '@bot/signer';"],
      ['tools/a.ts', "import 'typescript'; import 'node:module'; import '../packages/engine/src/a.ts';"],
    ];
    for (const [file, code] of ok) assert.deepEqual(check(file as string, code as string), [], file);
  });

  it('refuses everything else, naming the rule', () => {
    const cases: Array<[string, string, string]> = [
      ['packages/signer/src/a.ts', "import '@bot/venue';", 'E_UNDECLARED_IMPORT'],
      ['packages/signer/test/a.ts', "import 'fast-check';", 'E_UNDECLARED_IMPORT'],
      ['packages/engine/src/a.ts', "import '@solana/kit';", 'E_UNDECLARED_IMPORT'],
      ['packages/engine/src/a.ts', "import 'typescript';", 'E_UNDECLARED_IMPORT'],
      ['packages/engine/test/a.ts', "import '@solana/web3.js/lib/x.js';", 'E_WEB3_BANNED'],
      ['packages/engine/src/a.ts', "import 'fs';", 'E_IMPORT_BUILTIN'],
      ['packages/engine/src/a.ts', "import 'fs/promises';", 'E_IMPORT_BUILTIN'],
      ['packages/engine/src/a.ts', "import 'node:nope';", 'E_IMPORT_UNKNOWN'],
      ['packages/engine/src/a.ts', "import 'node:module';", 'E_IMPORT_FORBIDDEN'],
      ['packages/signer/src/a.ts', "import { DatabaseSync } from 'node:sqlite';", 'E_SQLITE_OUTSIDE_M24'],
      ['packages/engine/src/m09/a.ts', "import 'node:sqlite';", 'E_SQLITE_OUTSIDE_M24'],
      ['packages/engine/src/a.ts', "const s = await import('node:sqlite');", 'E_SQLITE_OUTSIDE_M24'],
      ['packages/engine/src/m24x/a.ts', "import 'node:sqlite';", 'E_SQLITE_OUTSIDE_M24'],
      ['packages/engine/src/m25/a.ts', "import { schemaTx } from '../m24/schema-tx.ts';", 'E_SCHEMA_TX_IMPORT'],
      ['packages/engine/src/m24/repos.ts', "export { schemaTx } from './schema-tx.ts';", 'E_SCHEMA_TX_IMPORT'],
      ['packages/engine/src/index.ts', "const m = await import('./m24/schema-tx.ts');", 'E_SCHEMA_TX_IMPORT'],
      ['packages/engine/src/m25/a.ts', "import { schemaTx } from '../m24/schema-tx.js';", 'E_SCHEMA_TX_IMPORT'],
      ['packages/engine/src/m25/a.ts', "import '../m24/schema-tx.mts';", 'E_SCHEMA_TX_IMPORT'],
      ['packages/engine/src/m25/a.ts', "import '../m24/schema-tx.cts';", 'E_SCHEMA_TX_IMPORT'],
      ['packages/engine/src/m25/a.ts', "import '../m24/schema-tx';", 'E_SCHEMA_TX_IMPORT'],
      ['packages/core/src/a.ts', "import '../../engine/src/m24/schema-tx.ts';", 'E_SCHEMA_TX_IMPORT'],
      ['apps/web/src/a.ts', "import '../../../packages/engine/src/m24/schema-tx.js';", 'E_SCHEMA_TX_IMPORT'],
      ['tools/a.ts', "import '../packages/engine/src/m24/schema-tx.ts';", 'E_SCHEMA_TX_IMPORT'],
      ['packages/engine/src/m09/a.ts', "import '@bot/engine/src/m24/schema-tx.js';", 'E_SCHEMA_TX_IMPORT'],
      ['packages/venue/src/a.ts', "import '../../engine/test/helpers.ts';", 'E_SRC_IMPORTS_TEST'],
      ['apps/web/src/zzrt/e.ts', "export * from '../../../../packages/engine/test/helpers.ts';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "import './tests/x.ts';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "import '../tests/x.ts';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "import './__tests__/x.ts';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "import './x.test.ts';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "import './x.spec.ts';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/zzrt/a.ts', "export { schemaFixture } from '../../test/helpers.ts';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "import { schemaFixture } from '../test/helpers.ts';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "const h = await import('../test/helpers.ts');", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "export * from '../test';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "import '@bot/engine/test/helpers.ts';", 'E_SRC_IMPORTS_TEST'],
      ['packages/engine/src/a.ts', "import '../../venue/src/x.ts';", 'E_IMPORT_PATH'],
      ['packages/signer/src/a.ts', "import '../../../node_modules/fast-check/lib/fast-check.js';", 'E_IMPORT_PATH'],
      ['packages/engine/src/a.ts', "import '../node_modules/x/index.js';", 'E_IMPORT_PATH'],
      ['packages/engine/src/a.ts', "import '/abs/x.js';", 'E_IMPORT_PATH'],
      ['packages/engine/src/a.ts', "import 'file:///x.js';", 'E_IMPORT_PATH'],
      ['packages/engine/src/a.ts', "import 'data:text/javascript,export default 1';", 'E_IMPORT_PATH'],
      ['packages/engine/src/a.ts', "import '#internal';", 'E_IMPORT_PATH'],
      ['packages/engine/src/a.ts', 'import(name);', 'E_IMPORT_DYNAMIC'],
      ['tools/a.ts', "import 'eslint';", 'E_UNDECLARED_IMPORT'],
      ['tools/a.ts', "import '../../outside.ts';", 'E_IMPORT_PATH'],
      ['tools/a.ts', "import '../..';", 'E_IMPORT_PATH'],
      ['tools/a.ts', "import 'node_modules/x';", 'E_UNDECLARED_IMPORT'],
      ['a.ts', "import './node_modules/x/y.js';", 'E_IMPORT_PATH'],
    ];
    for (const [file, code, expected] of cases) assert.deepEqual(check(file, code), [expected], `${file}: ${code}`);
  });

  it('refuses a relative specifier Node reads as a URL to another file than tsc and ESLint read (C01 red-team round 5, A4)', () => {
    // WHATWG URL parsing, as Node's ESM_RESOLVE uses it: %2e%2e, .%2E and %2e. are "..", a backslash is "/", tab and
    // newline are dropped, "?" and "#" end the path, other escapes are decoded, an encoded "/" names no file path.
    const signer = 'packages/signer/src/hop.ts';
    assert.equal(urlTarget('./%2e%2e/%2e%2e/%2e%2e/lib/fc.ts', signer), '/lib/fc.ts');
    assert.equal(urlTarget('./a%2fb.ts', signer), null);
    assert.equal(urlTarget('./b.ts', 'packages/signer/src/%2e%2e/x\\#?.ts'), '/packages/signer/src/%2e%2e/b.ts', 'the importing path is encoded');
    const refused = [
      './%2e%2e/%2e%2e/%2e%2e/lib/fc.ts', './.%2E/.%2E/.%2E/lib/fc.ts', './%2e./%2E./%2e./lib/fc.ts', './..\\..\\..\\lib/fc.ts',
      './%2e%2e/%2e%2e/%2e%2e/node_modules/@solana/web3.js/lib/index.cjs.js', './.\t./.\t./.\t./lib/fc.ts',
      './../../../lib/fc.ts#/../../packages/signer/src/x.ts', './x.ts?/../../../../lib', './%2e%2e/src/fc.ts', './%41.ts', './a%2fb.ts', './/../x.ts',
    ];
    for (const s of refused) assert.deepEqual(check(signer, `export const m = import('${s.replaceAll('\\', '\\\\').replaceAll('\t', '\\t')}');\n`), ['E_IMPORT_PATH'], s);
    const ref: ModuleRef = { kind: 'import()', specifier: './%2e%2e/%2e%2e/%2e%2e/lib/fc.ts', line: 1 };
    const manifest: Manifest = { file: 'packages/signer/package.json', dir: 'packages/signer', json: { name: '@bot/signer' } };
    assert.equal(checkRef(ref, signer, { manifest, root: undefined, test: false })?.message, '"./%2e%2e/%2e%2e/%2e%2e/lib/fc.ts": Node resolves it as a URL to '
      + '/lib/fc.ts, but tsc and ESLint read /packages/signer/src/%2e%2e/%2e%2e/%2e%2e/lib/fc.ts (paths from the repository root); write a plain '
      + 'relative path (no %, \\, ?, #, tab, newline or empty segment)');
    assert.match(String(checkRef({ ...ref, specifier: './a%2fb.ts' }, signer, { manifest, root: undefined, test: false })?.message), /as a URL to no file path, but/);
    assert.deepEqual(check('tools/a.ts', "import './%2e%2e/x.ts';\n"), ['E_IMPORT_PATH'], 'outside packages too');
    for (const s of ['./a b.ts', './x/', '.', '..', './sub/../b.ts']) assert.deepEqual(check(signer, `import '${s}';\n`), [], s);
    assert.deepEqual(check('a.ts', "import '.';\n"), [], 'the repository root itself');
  });

  it('the red-team repro fails the policy CLI run: a deferred import in the signer through a %2e%2e path with a decoy (A4)', () => {
    const repo = goodRepo();
    try {
      mkdirSync(join(repo.dir, 'lib'));
      writeFileSync(join(repo.dir, 'lib/fc.ts'), "import ts from 'typescript';\n\nexport const fc = ts;\n");   // declared by the root manifest
      for (const decoy of ['packages/signer/src/%2e%2e/%2e%2e/%2e%2e/lib', 'packages/signer/src/..\\..\\..\\lib']) {
        mkdirSync(join(repo.dir, decoy), { recursive: true });
        writeFileSync(join(repo.dir, decoy, 'fc.ts'), "export const fc = 'decoy';\n");
      }
      writeFileSync(join(repo.dir, 'packages/signer/src/hop.ts'), [
        "export const hop = async (): Promise<unknown> => (await import('./%2e%2e/%2e%2e/%2e%2e/lib/fc.ts')).fc;",
        "export const hop2 = async (): Promise<unknown> => (await import('./..\\\\..\\\\..\\\\lib/fc.ts')).fc;",
      ].join('\n'));
      repo.commit('signer hop through a URL-encoded path');
      assert.deepEqual(runChecks(repo.dir, 'main').map((f) => `${f.code} ${f.file}`),
        ['E_IMPORT_PATH packages/signer/src/hop.ts:1', 'E_IMPORT_PATH packages/signer/src/hop.ts:2']);
    } finally { repo.remove(); }
  });

  it('a workspace without a name, and a missing root manifest', () => {
    const anon: Manifest = { file: 'packages/anon/package.json', dir: 'packages/anon', json: {} };
    const ref: ModuleRef = { kind: 'import', specifier: 'x', line: 3 };
    assert.equal(checkRef(ref, 'packages/anon/test/a.ts', { manifest: anon, root: undefined, test: true })?.message,
      'x is not declared in packages/anon/package.json (any dependency field, or the root package.json)');
    assert.equal(checkRef(ref, 'packages/anon/src/a.ts', { manifest: anon, root: undefined, test: false })?.file, 'packages/anon/src/a.ts:3');
    const { snapshot, files } = snapshotWith({ 'tools/a.ts': "import 'nope';\n" });
    assert.deepEqual(checkImports({ ...snapshot, manifests: [] }, files), []);
  });

  it('this repository passes, and a bad import fails the policy CLI run', () => {
    const { snapshot } = readRepo(REPO_ROOT);
    assert.deepEqual(checkImports(snapshot, gitAt(REPO_ROOT).listFiles()), []);
    const repo = goodRepo();
    try {
      mkdirSync(join(repo.dir, 'packages/signer/src'), { recursive: true });
      writeFileSync(join(repo.dir, 'packages/signer/src/a.ts'), "import ts from 'typescript';\nexport const v = ts.version;\n");
      repo.commit('signer imports a hoisted package');
      assert.deepEqual(codes(runChecks(repo.dir, 'main')), ['E_THIRD_PARTY_RUNTIME']);
    } finally { repo.remove(); }
  });
});
