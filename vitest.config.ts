import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Runtime trap around engine code: clock, randomness, timers, Intl and module loading throw (ENG-1).
    setupFiles: ['packages/core/test/setup.ts'],
  },
});
