import { configDefaults, defineConfig } from 'vitest/config';

// Light and CPU-heavy suites share the default sequence group and its two-worker pool, with separate timeout defaults.
// Heap and relative-time measurements run afterward, alone, so another file's allocations do not distort their limits.
const HEAVY = [
  'packages/core/test/stats-g2.test.ts',
  'packages/core/test/stats-gates.test.ts',
  'packages/core/test/stats-simulation.test.ts',
  'packages/backtest/test/run.test.ts',
  'packages/backtest/test/study.test.ts',
  'packages/backtest/test/full-study.test.ts',
  // RES-3: the CLI test writes a zstd fixture dataset (~25 s measured).
  'packages/backtest/test/research.test.ts',
  // RES-5: the CLI test writes a zstd fixture dataset.
  'packages/backtest/test/survival.test.ts',
];
const MEASUREMENTS = [
  'packages/core/test/gates/deployer-compact.test.ts',
  'packages/worker/test/create-compact.test.ts',
  // Z01 (C01 review R7): canonicalJson's cost against a plain serialiser, best of five, run alone.
  'tools/bench/test/canon.test.ts',
];
// The Blueprint packages (B-M30-01) and the policy tools: their own project, without Zeroed's engine runtime trap,
// which closes the Function constructor for the whole run (ESLint's rule-schema validator compiles with it).
const BLUEPRINT_PACKAGES = ['types', 'botctl', 'contract', 'dashboard', 'decoders', 'engine', 'exitpath', 'research', 'sentinel', 'signer', 'venue'];
const BLUEPRINT = [...BLUEPRINT_PACKAGES.map((p) => `packages/${p}/test/**/*.test.ts`), 'tools/**/test/**/*.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'light',
          maxWorkers: 2,
          // Slowest light test measured: 6.0 s with the machine busy (ledger six-process test, which sets 20 s itself).
          // The default 5 s sat 0.8 s above the 1 to 2.5 s tests, so a busy runner failed them. 30 s is 5x the slowest.
          testTimeout: 30_000,
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...HEAVY, ...MEASUREMENTS, ...BLUEPRINT],
        },
      },
      {
        // No `extends`: the root setupFiles (Zeroed's engine trap) do not apply.
        test: {
          name: 'blueprint',
          include: BLUEPRINT,
          exclude: [...configDefaults.exclude, ...MEASUREMENTS],
          maxWorkers: 2,
          // The bad-commit self-tests build and check throw-away git repositories (C01 ran them under node:test).
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'heavy',
          include: HEAVY,
          maxWorkers: 2,
          // Slowest heavy test measured: 60 s (stats-g2) with both projects running; 300 s is 5x that.
          testTimeout: 300_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'measurements',
          include: MEASUREMENTS,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
          testTimeout: 30_000,
        },
      },
    ],
    // Runtime trap around engine code: clock, randomness, timers, Intl and module loading throw (ENG-1).
    setupFiles: ['packages/core/test/setup.ts'],
  },
});
