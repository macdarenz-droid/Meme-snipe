import { configDefaults, defineConfig } from 'vitest/config';

// The CPU-heavy suites (simulation, backtest runs) get their own project and two workers each project, so the heavy files
// never take more than half the cores and cannot starve the rest. Measured on a 4-core runner: stats-g2 took 62 s on CI next to the
// ledger tests, and the ledger replay test timed out at 5 s (CI-1). Everything else shares the other project.
const HEAVY = [
  'packages/core/test/stats-g2.test.ts',
  'packages/core/test/stats-gates.test.ts',
  'packages/core/test/stats-simulation.test.ts',
  'packages/backtest/test/run.test.ts',
  // RES-3: the CLI test writes a zstd fixture dataset (~25 s measured).
  'packages/backtest/test/research.test.ts',
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
          exclude: [...configDefaults.exclude, ...HEAVY],
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
    ],
    // Runtime trap around engine code: clock, randomness, timers, Intl and module loading throw (ENG-1).
    setupFiles: ['packages/core/test/setup.ts'],
  },
});
