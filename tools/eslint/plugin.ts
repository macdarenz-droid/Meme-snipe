// The bot's ESLint rule package (B-M19-01 logic 3, shared with B-M30-01; B-M24-01 logic 3). Enabled in eslint.config.mjs.
import type { ESLint } from 'eslint';
import noAmbientClockOrRandom from './rules/no-ambient-clock-or-random.ts';
import noAwaitInWithTx from './rules/no-await-in-withtx.ts';
import noNumberOnUnits from './rules/no-number-on-units.ts';
import noSharedTypeRedefinition from './rules/no-shared-type-redefinition.ts';

const plugin: ESLint.Plugin = {
  meta: { name: 'bot' },
  rules: {
    'no-number-on-units': noNumberOnUnits,
    'no-ambient-clock-or-random': noAmbientClockOrRandom,
    'no-shared-type-redefinition': noSharedTypeRedefinition,
    'no-await-in-withtx': noAwaitInWithTx,
  },
};
export default plugin;
