// The repository's ESLint configuration (eslint.config.mjs), linted the way `npm run lint` does (`--config`, no config
// lookup): the clock and RNG exemption covers only the exact module paths, never any file that happens to be named
// clock.ts or rng.ts.
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { ESLint } from 'eslint';
import { LINT_COMMAND } from '../../policy/lintconfig.ts';
import { knownProgramIds } from '../rules/no-program-id-literal.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root, overrideConfigFile: 'eslint.config.mjs' });
const RULE = 'bot/no-ambient-clock-or-random';

async function rulesHit(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

describe('eslint.config.mjs: clock and RNG exemption', () => {
  for (const file of ['packages/engine/src/zz/clock.ts', 'packages/engine/src/clock/wall.ts', 'packages/research/src/rng.ts', 'packages/sentinel/src/rng/x.ts', 'tools/x/clock.ts']) {
    it(`a wall-clock or Math.random read in ${file} fails lint`, async () => {
      assert.deepEqual(await rulesHit(file, 'export const t = Date.now() + Math.random();\n'), [RULE, RULE]);
    });
  }

  it('the listed clock module may read the wall clock', async () => {
    assert.deepEqual(await rulesHit('tools/policy/clock.ts', 'export function wallClockNowMs(): number {\n  return Date.now();\n}\n'), []);
  });

  it('destructuring Date.now fails lint in a module', async () => {
    assert.deepEqual(await rulesHit('packages/engine/src/a.ts', 'const { now } = Date;\nexport const t = now();\n'), [RULE]);
  });
});

describe('eslint.config.mjs: every source extension is linted (C01 red-team M2)', () => {
  const web3 = "import { Connection } from '@solana/web3.js';\nexport const c = Connection;\nexport const t = Date.now() + Math.random();\n";
  for (const file of ['packages/engine/src/rt-web3.js', 'packages/signer/src/rt-web3.mts', 'packages/engine/src/a.cts', 'packages/signer/src/a.cjs', 'packages/engine/src/a.mjs']) {
    it(`${file}: the web3.js ban and the bot rules apply`, async () => {
      assert.deepEqual(await rulesHit(file, web3), ['no-restricted-imports', RULE, RULE]);
    });
  }
  it('tsx and jsx files are linted too', async () => {
    assert.deepEqual(await rulesHit('packages/dashboard/src/a.tsx', 'export const A = () => <b>{Date.now()}</b>;\n'), [RULE]);
    assert.deepEqual(await rulesHit('tools/a.jsx', 'export const A = () => <b>{Math.random()}</b>;\n'), [RULE]);
  });
});

describe('eslint.config.mjs: dashboard money rule (UI-T01 acceptance 3)', () => {
  it('parseFloat(x.net_pnl_lamports) in the dashboard fails lint with the money-rule message', async () => {
    const [result] = await eslint.lintText('export const v = (x: { net_pnl_lamports: string }) => parseFloat(x.net_pnl_lamports);\n',
      { filePath: join(root, 'packages/dashboard/src/a.ts') });
    const money = (result?.messages ?? []).filter((m) => m.ruleId === 'bot/no-number-on-money');
    assert.equal(money.length, 1);
    assert.match(money[0]?.message ?? '', /^Money rule: parseFloat\(\) on "net_pnl_lamports"/);
  });
  it('the dashboard clock module may read the wall clock; other dashboard files may not', async () => {
    assert.deepEqual(await rulesHit('packages/dashboard/src/lib/clock.ts', 'export const c = { nowMs: () => Date.now() };\n'), []);
    assert.deepEqual(await rulesHit('packages/dashboard/src/lib/other.ts', 'export const c = { nowMs: () => Date.now() };\n'), [RULE]);
  });
});

describe('eslint.config.mjs: dashboard number formatting (UI-T03 Definition of done)', () => {
  const code = 'export const t = (n: number): string => n.toFixed(2) + n.toLocaleString();\n';
  it('toFixed and toLocaleString fail lint in dashboard components', async () => {
    assert.deepEqual(await rulesHit('packages/dashboard/src/components/a.ts', code), ['bot/no-number-formatting', 'bot/no-number-formatting']);
  });
  it('the money module may format numbers; a file of the same name elsewhere may not', async () => {
    assert.deepEqual(await rulesHit('packages/dashboard/src/lib/money.ts', code), []);
    assert.deepEqual(await rulesHit('packages/dashboard/src/other/money.ts', code), ['bot/no-number-formatting', 'bot/no-number-formatting']);
  });
});

describe('eslint.config.mjs: code built from strings (C01 review R2)', () => {
  for (const [code, rule] of [
    ["export const v = eval('1');\n", 'no-eval'], ["export const v = globalThis.eval('1');\n", 'no-eval'],
    ["export const f = new Function('return 1');\n", 'no-new-func'], ["export const f = Function('return 1');\n", 'no-new-func'],
    ["setTimeout('run()', 1);\n", 'no-implied-eval'], ["globalThis.setInterval(`run()`, 1);\n", 'no-implied-eval'],
  ] as const) {
    it(`${code.trim()} fails lint with ${rule}`, async () => {
      assert.deepEqual(await rulesHit('packages/signer/src/a.ts', code), [rule]);
    });
  }
});

describe('npm run lint loads only eslint.config.mjs (C01 review R1)', () => {
  it('the lint script passes --config, so a root eslint.config.js (looked up before .mjs) cannot replace the rules', () => {
    const lint = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['lint'] ?? '';
    assert.ok(lint.startsWith(LINT_COMMAND), lint);
    const dir = mkdtempSync(join(tmpdir(), 'eslint-config-'));
    try {
      writeFileSync(join(dir, 'eslint.config.mjs'), "export default [{ rules: { 'no-undef': 'error' } }];\n");
      writeFileSync(join(dir, 'eslint.config.js'), 'export default [{}];\n');
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
      writeFileSync(join(dir, 'a.js'), 'undefinedThing();\n');
      const bin = join(root, 'node_modules/eslint/bin/eslint.js');
      execFileSync(process.execPath, [bin, '--max-warnings=0', 'a.js'], { cwd: dir, stdio: 'pipe' });   // lookup: the empty .js wins
      const r = spawnSync(process.execPath, [bin, ...LINT_COMMAND.trim().split(' ').slice(1), '--max-warnings=0', 'a.js'], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /no-undef/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// A-M01-01 (ported from Snipe-solana card C03 #6 @ 6ae4d62; C11's tools/fixtures/lib.ts is not ported, so the
// registry is the only exempt file).
describe('eslint.config.mjs: program ID literals (A-M01-01)', () => {
  const id = [...knownProgramIds()][1] as string;
  const code = `export const p = '${id}';\n`;
  for (const file of ['packages/engine/src/a.ts', 'packages/decoders/src/a.ts', 'packages/engine/test/a.test.ts', 'tools/a.ts', 'packages/venue/src/other.ts']) {
    it(`a program ID literal in ${file} fails lint`, async () => {
      assert.deepEqual(await rulesHit(file, code), ['bot/no-program-id-literal']);
    });
  }
  it('packages/venue/src/constants.ts may hold program IDs', async () => {
    assert.deepEqual(await rulesHit('packages/venue/src/constants.ts', code), []);
  });
  // Z03 ruling m7: any address literal, a mint for instance; fixture files may hold them.
  const mint = `export const m = 'So${'1'.repeat(40)}2';\n`;
  for (const file of ['packages/engine/src/a.ts', 'packages/decoders/test/a.test.ts', 'packages/contract/src/other.ts']) {
    it(`an address literal in ${file} fails lint`, async () => {
      assert.deepEqual(await rulesHit(file, mint), ['bot/no-program-id-literal']);
    });
  }
  for (const file of ['packages/venue/src/constants.ts', 'fixtures/a.ts', 'packages/contract/src/fixtures.ts', 'packages/decoders/test/fixtures.ts']) {
    it(`${file} may hold address literals`, async () => {
      assert.deepEqual(await rulesHit(file, mint), []);
    });
  }
});

// Z03 ruling 32 (#304 merge red team): only named fixture files may hold addresses, none may hold a program ID, and only
// the dashboard catalogue and test code may import a fixtures module.
describe('eslint.config.mjs: fixture files and their importers (Z03 ruling 32)', () => {
  const id = [...knownProgramIds()][0] as string;
  const mint = `export const m = 'So${'1'.repeat(40)}2';\n`;

  it('the red team\'s repro fails: a program ID in packages/engine/src/fixtures.ts, imported by production code', async () => {
    assert.deepEqual(await rulesHit('packages/engine/src/fixtures.ts', `export const PUMP = '${id}';\n`), ['bot/no-program-id-literal']);
    assert.deepEqual(await rulesHit('packages/engine/src/a.ts', "import { PUMP } from './fixtures.ts';\nexport const p = PUMP;\n"), ['bot/no-fixtures-import']);
  });

  for (const file of ['packages/engine/src/fixtures.ts', 'packages/signer/src/fixtures.ts', 'packages/venue/src/fixtures.ts']) {
    it(`${file} is not a fixture file: an address literal there fails lint`, async () => {
      assert.deepEqual(await rulesHit(file, mint), ['bot/no-program-id-literal']);
    });
  }

  for (const file of ['packages/dashboard/src/fixtures.ts', 'packages/contract/src/fixtures.ts', 'packages/decoders/test/fixtures.ts', 'fixtures/a.ts']) {
    it(`a fixtures value equal to a program ID fails lint in ${file}; an address does not`, async () => {
      assert.deepEqual(await rulesHit(file, `export const p = '${id}';\n`), ['bot/no-program-id-literal']);
      assert.deepEqual(await rulesHit(file, `export const p = 'x:${id} ';\n`), ['bot/no-program-id-literal']);
      assert.deepEqual(await rulesHit(file, mint), []);
    });
  }

  it('the dashboard catalogue and test code may import a fixtures module', async () => {
    assert.deepEqual(await rulesHit('packages/dashboard/src/catalogue/sections/x.ts', "import { SAMPLE_MINT } from '../../fixtures.ts';\nexport const m = SAMPLE_MINT;\n"), []);
    assert.deepEqual(await rulesHit('packages/dashboard/test/x.test.ts', "import { SAMPLE_MINT } from '../src/fixtures.ts';\nexport const m = SAMPLE_MINT;\n"), []);
    assert.deepEqual(await rulesHit('packages/contract/test/x.test.ts', "import { FIXTURES } from '@bot/contract/fixtures';\nexport const f = FIXTURES;\n"), []);
  });

  const imports = [
    "import { SAMPLE_MINT } from '../fixtures.ts';\nexport const m = SAMPLE_MINT;\n",
    "export { SAMPLE_MINT } from '../fixtures';\n",
    "export * from './fixtures.js';\n",
    "import { FIXTURES } from '@bot/contract/fixtures';\nexport const f = FIXTURES;\n",
    "export const f = () => import('./fixtures.ts');\n",
    "export const f = () => import(`./test/fixtures.ts`);\n",
  ];
  for (const file of ['packages/dashboard/src/app/x.ts', 'packages/engine/src/x.ts', 'packages/contract/src/x.ts', 'tools/x.ts']) {
    it(`${file} may not import a fixtures module (import, re-export, export *, package path, dynamic import)`, async () => {
      for (const code of imports) assert.deepEqual(await rulesHit(file, code), ['bot/no-fixtures-import'], code);
    });
  }

  it('a module merely named like fixtures is not a fixtures import', async () => {
    assert.deepEqual(await rulesHit('packages/engine/src/x.ts', "import { a } from './fixtures-lib.ts';\nimport { b } from '../../fixtures/mainnet/x.ts';\nexport const c = a + b;\n"), []);
  });
});
