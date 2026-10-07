// ESLint configuration (C01 review finding R1). ESLint 10 looks for eslint.config.{js,mjs,cjs,ts,mts,cts} from each
// linted file's directory upwards and takes eslint.config.js before eslint.config.mjs (eslint 10.11.0
// lib/config/config-loader.js, FLAT_CONFIG_FILENAMES and locateConfigFileToUse), so a second config file anywhere would
// replace the reviewed rules for every file below it. `pnpm lint` therefore passes `--config eslint.config.mjs`,
// which switches that lookup off, and this check refuses every other ESLint config file, so the only lint
// configuration is the reviewed one.
import { DATA_DIRS, ESLINT_CONFIG, ESLINT_CONFIG_PATTERN } from './config.ts';
import { finding, type Finding } from './finding.ts';
import type { RepoSnapshot } from './repo.ts';

/** How the root `lint` script must start: ESLint with the reviewed config and no config lookup. */
export const LINT_COMMAND = `eslint --config ${ESLINT_CONFIG} `;

export function checkLintConfig(snapshot: RepoSnapshot, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f !== ESLINT_CONFIG && ESLINT_CONFIG_PATTERN.test(f) && !DATA_DIRS.some((d) => f.startsWith(d))) {
      findings.push(finding('E_ESLINT_CONFIG', f, `only the root ${ESLINT_CONFIG} configures ESLint; another config file would replace its rules`));
    }
  }
  const lint = snapshot.manifests.find((m) => m.dir === '')?.json.scripts?.['lint'];
  if (lint === undefined || !lint.startsWith(LINT_COMMAND)) {
    findings.push(finding('E_ESLINT_CONFIG', 'package.json', `the lint script must start with "${LINT_COMMAND}" so ESLint loads only the reviewed config`));
  }
  return findings;
}
