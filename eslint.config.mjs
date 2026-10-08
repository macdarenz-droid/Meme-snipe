// Lint configuration (B-M30-01 logic 6, B-M19-01 logic 3). Inline eslint-disable comments are not honoured:
// a rule is changed only here, in review. `pnpm lint` loads this file with `--config`, which switches off ESLint's
// per-directory config lookup, and the policy check refuses any other eslint.config.* (C01 review finding R1).
// Zeroed's own source files (tools/policy/zeroed-files.txt, the manifest of config.ts ZEROED_FILES_MANIFEST) are not
// linted: old Zeroed code stays as it is (docs/MIGRATION.md) and reads the wall clock throughout. Those exact files,
// not the folders they sit in (round 1 review F4, red team RT-01), so a new source file under apps/, ops/ or research/
// is linted like any other. The Zeroed-only package folders (config.ts ZEROED_PACKAGE_PREFIXES) are not linted at all,
// new files included (supervisor ruling 3.1): these rules are the Blueprint's structure; the policy check's safety
// rules still read those files.
import tsParser from './tools/eslint/parser.ts';
import bot from './tools/eslint/plugin.ts';
import { ZEROED_PACKAGE_PREFIXES } from './tools/policy/config.ts';
import { zeroedSourceFiles } from './tools/policy/scope.ts';

const WEB3_V1 = 'Banned in the engine and signer: use @solana/kit (B-M30-01; LD-05, LD-36, TH-37).';

/**
 * The clock and RNG modules: the only files allowed to read the wall clock or Math.random (B-M19-01 logic 3). Exact
 * paths, never a file-name pattern, so a new clock.ts or rng.ts elsewhere is linted like any other file. The card that
 * builds a clock or RNG module adds its path here, in review.
 */
const CLOCK_AND_RNG_MODULES = ['tools/policy/clock.ts'];

/**
 * Every JavaScript and TypeScript source extension, so no module escapes the rules by its extension. The policy check
 * also refuses any source under packages/ and tools/ that is not .ts (E_SOURCE_TYPE), so `tsc` sees every module.
 */
const SOURCES = ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx'];
const sources = (dir) => SOURCES.map((ext) => `${dir}**/*.${ext}`);

export default [
  { ignores: ['**/node_modules/**', 'coverage/**', 'tools/policy/test/fixtures/**', ...ZEROED_PACKAGE_PREFIXES.map((p) => `${p}**`), ...zeroedSourceFiles()] },
  {
    files: sources(''),
    // The Node timers no-implied-eval checks are declared, so the rule sees them as the globals they are.
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module', globals: { setTimeout: 'readonly', setInterval: 'readonly' } },
    linterOptions: { noInlineConfig: true },
    plugins: { bot },
    rules: {
      'bot/no-number-on-units': 'error',
      'bot/no-ambient-clock-or-random': 'error',
      'bot/no-shared-type-redefinition': 'error',
      // B-M24-01 logic 3: no await inside a withTx callback (ARCH 7.1).
      'bot/no-await-in-withtx': 'error',
      // Code built from strings loads modules the import check cannot see (C01 review finding R2).
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    files: CLOCK_AND_RNG_MODULES,
    rules: { 'bot/no-ambient-clock-or-random': 'off' },
  },
  {
    files: [...sources('packages/engine/'), ...sources('packages/signer/')],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: '@solana/web3.js', message: WEB3_V1 }],
        patterns: [{ group: ['@solana/web3.js/*'], message: WEB3_V1 }],
      }],
    },
  },
];
