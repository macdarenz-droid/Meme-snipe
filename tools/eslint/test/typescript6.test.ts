// The second TypeScript (supervisor, 2026-10-07): @typescript-eslint/parser 8.70.1 supports TypeScript below 6.1, so
// it resolves typescript 6.0.3 from the tools/ workspace project while the repository builds with 7.0.2. These tests
// prove which TypeScript each side resolves to, and that ESLint and the import-graph check really parse this
// repository's .ts files with it: a planted lint violation, a planted bad import and a parse error each fail; none
// passes silently.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, it } from 'vitest';
import { checkRef, moduleRefs } from '../../policy/imports.ts';
import { readRepo } from '../../policy/repo.ts';
import { zeroedSourceFiles } from '../../policy/scope.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root, overrideConfigFile: 'eslint.config.mjs' });
const versionFrom = (from: string, pkg: string): string =>
  (createRequire(from)(`${pkg}/package.json`) as { version: string }).version;

/** Every .ts file under the Blueprint packages' src/ and test/ directories and tools/ (fixtures and node_modules excluded). */
function blueprintSources(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = `${rel}/${d.name}`;
      if (d.name === 'node_modules' || path.startsWith('tools/policy/test/fixtures')) continue;
      if (d.isDirectory()) walk(path);
      else if (d.name.endsWith('.ts')) out.push(path);
    }
  };
  for (const p of ['types', 'botctl', 'contract', 'dashboard', 'engine', 'exitpath', 'research', 'sentinel', 'signer', 'venue']) walk(`packages/${p}`);
  walk('tools');
  return out.sort();
}

describe('typescript 6.0.3 for the ESLint parser only', () => {
  it('the parser resolves typescript 6.0.3; the repository root (tsc, every package) resolves 7.0.2', () => {
    const estree = createRequire(join(root, 'tools/package.json')).resolve('@typescript-eslint/typescript-estree');
    assert.equal(versionFrom(estree, 'typescript'), '6.0.3');
    assert.equal(versionFrom(join(root, 'package.json'), 'typescript'), '7.0.2');
    assert.equal(versionFrom(join(root, 'packages/types/package.json'), 'typescript'), '7.0.2');
  });

  it('ESLint parses every Blueprint .ts file of this repository without a fatal error', async () => {
    const files = blueprintSources();
    assert.ok(files.length > 50, `${files.length} files`);
    const results = await eslint.lintFiles(files.map((f) => join(root, f)));
    assert.equal(results.length, files.length, 'no file was ignored');
    assert.deepEqual(results.flatMap((r) => r.messages.filter((m) => m.fatal === true).map((m) => `${r.filePath}: ${m.message}`)), []);
    assert.deepEqual(results.filter((r) => r.errorCount > 0).map((r) => r.filePath), []);
  });

  it('a lint violation planted in a real module fails; a parse error fails as a fatal error, never a pass', async () => {
    const file = join(root, 'packages/types/src/units.ts');
    const real = readFileSync(file, 'utf8');
    const [planted] = await eslint.lintText(`${real}\nexport const plantedNow = Date.now();\n`, { filePath: file });
    assert.deepEqual(planted?.messages.map((m) => m.ruleId), ['bot/no-ambient-clock-or-random']);
    const [typed] = await eslint.lintText('type A = { a: 1 } satisfies object;\nexport const n = Number(x satisfies bigint as bigint);\ndeclare const feeLamports: bigint;\nexport const m = Number(feeLamports);\n',
      { filePath: join(root, 'packages/engine/src/planted.ts') });
    assert.deepEqual(typed?.messages.map((m) => m.ruleId ?? (m.fatal === true ? 'fatal' : '?')), ['fatal'], 'TS-only syntax that is wrong is a parse error');
    const [broken] = await eslint.lintText('export const = ;\n', { filePath: join(root, 'packages/engine/src/planted.ts') });
    assert.equal(broken?.messages[0]?.fatal, true);
    assert.ok((broken?.errorCount ?? 0) > 0, 'a parse error counts as an error, so `eslint --max-warnings=0` exits 1');
    const [generic] = await eslint.lintText('export function f<T extends bigint>(x: T): T { return x; }\ndeclare const slot: bigint;\nexport const s = parseInt(String(slot), 10);\n',
      { filePath: join(root, 'packages/engine/src/planted.ts') });
    assert.deepEqual(generic?.messages.map((m) => m.ruleId), ['bot/no-number-on-units'], 'TypeScript generics parse; the unit rule fires');
  });

  it('lints a new source file under a Zeroed folder, and still ignores Zeroed\'s own files (red team RT-01)', async () => {
    // Before the Zeroed manifest (round 1 review F4) the lint configuration ignored the folders, so a new file under
    // research/, ops/ or apps/ was never linted. Only the manifest's own files are ignored now.
    const planted = 'export const seenAt = Date.now();\nexport const pick = Math.random();\n';
    for (const file of ['research/blueprint/feed.ts', 'ops/recorder/feed.ts', 'apps/feed/src/index.ts']) {
      const [result] = await eslint.lintText(planted, { filePath: join(root, file), warnIgnored: false });
      assert.deepEqual(result?.messages.map((m) => m.ruleId), ['bot/no-ambient-clock-or-random', 'bot/no-ambient-clock-or-random'], file);
    }
    const zeroed = zeroedSourceFiles();
    assert.ok(zeroed.length > 500, `${zeroed.length} Zeroed source files are ignored`);
    for (const file of ['apps/web/src/main.tsx', 'packages/core/src/amm/pump-curve.ts']) {
      assert.ok(zeroed.includes(file), file);
      assert.equal(await eslint.isPathIgnored(join(root, file)), true, file);
    }
    for (const file of ['research/blueprint/feed.ts', 'packages/types/src/units.ts']) {
      assert.equal(await eslint.isPathIgnored(join(root, file)), false, file);
    }
  });

  it('the import check parses every Blueprint .ts file, fails a planted bad import and fails on a parse error', () => {
    for (const f of blueprintSources()) assert.doesNotThrow(() => moduleRefs(readFileSync(join(root, f), 'utf8'), f), f);
    const { snapshot } = readRepo(root);
    const signer = snapshot.manifests.find((m) => m.json.name === '@bot/signer');
    assert.ok(signer);
    const scope = { manifest: signer, root: snapshot.manifests.find((m) => m.dir === ''), test: false };
    const refs = moduleRefs("import type { ParsedPath } from 'node:path';\nimport fc from 'fast-check';\nexport type L = ParsedPath;\nexport const x = fc satisfies unknown;\n", 'packages/signer/src/planted.ts');
    assert.deepEqual(refs.map((r) => checkRef(r, 'packages/signer/src/planted.ts', scope)?.code ?? null), [null, 'E_THIRD_PARTY_RUNTIME']);
    assert.throws(() => moduleRefs('export const = ;\n', 'packages/signer/src/planted.ts'));
  });
});
