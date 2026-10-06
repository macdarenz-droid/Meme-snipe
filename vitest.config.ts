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
];

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
          exclude: [...configDefaults.exclude, ...HEAVY, ...MEASUREMENTS],
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
