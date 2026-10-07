// Policy settings (B-M30-01; ARCH 12.3). Changing a value here loosens or tightens CI, so it is reviewed like CI.
// Ported from Snipe-solana card C01 (npm) to this repository's pnpm 10 toolchain (docs/MIGRATION.md "Toolchain").

/** Registry every third-party package must come from. pnpm records no tarball URL for it, only the integrity hash. */
export const REGISTRY = 'https://registry.npmjs.org/';

/** POLICY: a package version is adopted only once it is at least this old (ARCH 12.3; TH-37, TH-40). */
export const MIN_AGE_DAYS = 14;
/** The same rule in pnpm's own setting, `minimumReleaseAge`, a number of minutes (pnpm 10.x docs, settings.md). */
export const MIN_RELEASE_AGE_MINUTES = MIN_AGE_DAYS * 24 * 60;

/** The lockfile `pnpm install --frozen-lockfile` installs from, and the lockfile format it must have. */
export const LOCKFILE = 'pnpm-lock.yaml';
export const LOCKFILE_VERSION = '9.0';
/** Lockfiles of other package managers: an install with them would bypass these checks, so none may exist. */
export const OTHER_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];
/** pnpm's workspace file: the workspace globs and the dependency settings below. */
export const WORKSPACE_FILE = 'pnpm-workspace.yaml';

/**
 * Review label (B-M30-01 logic 1; review findings M1 and M3 of C01): a pull request that changes the lockfile or a
 * policy file (GUARDED_*) fails CI until a reviewer has read that diff and added this prefix plus the first
 * LOCK_REVIEW_HASH_HEX hex digits of the sha256 over the guarded files at the pull request's merge commit. The label is
 * bound to that content, so any later change to those files needs a new review. 32 hex digits (128 bits) make a
 * second content with the same label infeasible and keep the label (46 characters) within GitHub's 50-character limit.
 */
export const LOCK_REVIEW_LABEL_PREFIX = 'deps-reviewed:';
export const LOCK_REVIEW_HASH_HEX = 32;

/** Workspace packages whose public surface is frozen (ARCH 18; AGENTS.md file ownership). */
export const FROZEN_PACKAGES = ['packages/types'];

/** The one ESLint configuration `pnpm lint` loads (`eslint --config`); every other eslint.config.* is refused. */
export const ESLINT_CONFIG = 'eslint.config.mjs';
/** Config file names ESLint 10 looks up from each linted file's directory (eslint lib/config/config-loader.js). */
export const ESLINT_CONFIG_PATTERN = /(^|\/)eslint\.config\.[^/]*$/;

/**
 * Guarded paths: the installed lockfile, every file that decides what CI checks or how it installs, and every file a
 * check reads as reviewed input (review findings R1 and R3 of C01): DEPENDENCIES.md (the allowlist reviewer cells and
 * the age exceptions) and each frozen package's FREEZE.json and CHANGELOG.md (the sign-offs). vitest.config.ts decides
 * which tests `pnpm test` runs, and pnpm-workspace.yaml holds the install settings, so both are guarded too. CI runs the
 * pull request's own copy of these files, so a change to any of them needs the review label; the guard workflow runs
 * the base branch's copy of the drift check, so a pull request cannot switch the check off. Supervisor-owned
 * (AGENTS.md file ownership).
 */
export const GUARDED_FILES = [
  LOCKFILE, WORKSPACE_FILE, 'package.json', '.npmrc', '.node-version', 'DEPENDENCIES.md', 'vitest.config.ts',
  ...FROZEN_PACKAGES.flatMap((dir) => [`${dir}/FREEZE.json`, `${dir}/CHANGELOG.md`]),
];
export const GUARDED_DIRS = ['tools/', '.github/'];
/** tsconfig*.json and eslint.config.* at any depth. */
export const GUARDED_PATTERNS = [/(^|\/)tsconfig[^/]*\.json$/, ESLINT_CONFIG_PATTERN];

/** Packages with no third-party package anywhere in their production dependency closure (ARCH 12.3, B-M30-01 logic 4). */
export const NO_THIRD_PARTY = ['@bot/types', '@bot/signer'];

/** The sentinel depends only on internal packages and these (ARCH 12.3, B-M30-01 logic 4). */
export const SENTINEL = { name: '@bot/sentinel', allowedThirdParty: ['@solana/kit'] };

/** `@solana/web3.js` is banned in these packages, directly or transitively (B-M30-01 logic 6; LD-05, LD-36, TH-37). */
export const WEB3_BANNED_IN = ['@bot/engine', '@bot/signer'];
export const WEB3 = '@solana/web3.js';

/** Built-ins workspace packages may not import: node:module's createRequire and loader hooks bypass the import check. */
export const FORBIDDEN_IN_PACKAGES = ['node:module'];

/** Internal package scope: always a workspace link, never fetched from a registry. */
export const INTERNAL_SCOPE = '@bot/';
/**
 * The only dependency spec an internal package may use: pnpm's workspace protocol, which never falls back to the
 * registry (pnpm 10.x docs, workspaces.md). The `@bot` scope on npm is not ours.
 */
export const INTERNAL_SPEC = 'workspace:*';

/**
 * The policy tools' own workspace project. It exists only so @typescript-eslint/parser resolves its TypeScript peer
 * to the 6.x it supports while the repository builds with TypeScript 7; its files are checked like root-level code
 * (the way C01 checked tools/), not as a workspace package.
 */
export const TOOLS_DIR = 'tools';

/**
 * package.json scripts a package manager runs on its own during install (npm lifecycle docs; pnpm 10 also runs
 * `pnpm:devPreinstall` of the root). None may exist in this repository.
 */
export const INSTALL_LIFECYCLE_SCRIPTS = [
  'preinstall', 'install', 'postinstall', 'preuninstall', 'uninstall', 'postuninstall',
  'preprepare', 'prepare', 'postprepare', 'prepublish', 'prepack', 'postpack', 'dependencies', 'pnpm:devPreinstall',
];

/**
 * Old Zeroed code (docs/MIGRATION.md: "Old Zeroed code stays in place. It is not deleted, not run on the server, and
 * not fixed further"). The checks that would flag it today (imports, source types, code loading, symbolic links, lint,
 * the pump.fun host check, the allowlist of its dependencies, its workflows) skip these paths; every other path,
 * including any new one, is checked. `node tools/policy/bin/check.ts --include-zeroed` reports what they would find.
 * A path leaves this list when its code migrates; nothing is added to it without the supervisor.
 */
export const ZEROED_PATHS = [
  'apps/', 'brand/', 'docs/evidence/', 'docs/handover/', 'docs/research/', 'ops/', 'research/',
  'packages/backtest/', 'packages/core/', 'packages/ops/', 'packages/runner/', 'packages/worker/',
];
/** Zeroed's workflows (operations, data and the app build). ci.yml and guard.yml are always checked. */
export const ZEROED_WORKFLOWS = [
  'android-preview.yml', 'archive-check.yml', 'backtest-trial.yml', 'data-helius-pilot.yml', 'data-keep.yml', 'data-scan.yml',
  'deploy.yml', 'dryrun-rehearsal.yml', 'dryrun-smoke.yml', 'gpa-probe.yml', 'ops-e2e.yml', 'owner-programs.yml',
  'secrets-check.yml', 'spa-calibration.yml',
].map((f) => `.github/workflows/${f}`);

/**
 * Zeroed's jobs inside a checked workflow: ci.yml's historical-data job (the DATA-1 scanner tests) installs Go and
 * adds it to GITHUB_PATH. A job's GITHUB_PATH and GITHUB_ENV reach only that job's later steps, never the check job.
 */
export const ZEROED_JOBS: Readonly<Record<string, readonly string[]>> = { '.github/workflows/ci.yml': ['historical-data'] };

/** The integration branch: every pull request merges into it and deploys come from it (ops/deploy/tag.sh). */
export const INTEGRATION_BRANCH = 'ccr-14987baf-i6lrsl';
/** The base ref the policy compares against when POLICY_BASE_REF is not set (this repository has no `main`). */
export const DEFAULT_BASE_REF = `origin/${INTEGRATION_BRANCH}`;

/**
 * Steps the CI job must keep (B-M30-01 logic 1, 2, 5, 6 and the install-script edge case), in this order and in one
 * job, each as its own `run` step with no `if`, `continue-on-error` or `working-directory`. `shell: bash` makes GitHub
 * run the step with `-eo pipefail`, so a failing `pnpm test` still fails the piped step. The job keeps its name,
 * `check`: the deploy gate (ops/host/files/usr/local/lib/zeroed/logic.sh, ops/deploy/tag.sh) keys on it.
 */
export const CI_WORKFLOW = '.github/workflows/ci.yml';
export const CI_JOB = 'check';
export const CI_REQUIRED_STEPS: ReadonlyArray<{ run: string; shell?: string }> = [
  { run: 'pnpm install --frozen-lockfile' },
  { run: 'node tools/policy/bin/installed.ts' },
  { run: 'node tools/policy/bin/drift.ts' },
  { run: 'pnpm lint' },
  { run: 'pnpm typecheck' },
  { run: 'pnpm test 2>&1 | tee test-output.log', shell: 'bash' },
  { run: 'node tools/policy/bin/secrets.ts test-output.log' },
  { run: 'node tools/policy/bin/audit.ts' },
  { run: 'node tools/policy/bin/age.ts' },
];
/**
 * The one condition the CI job may carry: a draft pull request waits until it is marked ready (the
 * ready_for_review event then runs the job). A draft cannot be merged, so every merged head ran the checks.
 */
export const CI_JOB_IF = "${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}";

/** The guard workflow (review finding M3): pull_request_target, base branch code, the pull request as data only. */
export const GUARD_WORKFLOW = '.github/workflows/guard.yml';
export const GUARD_COMMAND = 'node ../base/tools/policy/bin/drift.ts';
/** The guard's checkouts and Node setup, input by input (review finding R6): the base branch, and the pull request's merge commit as data. */
export const GUARD_BASE_CHECKOUT: Readonly<Record<string, string>> = { path: 'base', 'persist-credentials': 'false' };
export const GUARD_PR_CHECKOUT: Readonly<Record<string, string>> = {
  ref: 'refs/pull/${{ github.event.pull_request.number }}/merge', path: 'pr', 'fetch-depth': '0', 'persist-credentials': 'false',
};
export const GUARD_SETUP_NODE: Readonly<Record<string, string>> = { 'node-version-file': 'base/.node-version' };

/**
 * pnpm subcommands a checked workflow may run: an install only with --frozen-lockfile, the root scripts and a recursive
 * run of the packages' own scripts. Anything else (add, dlx, exec, update, audit, …) is refused, and so are npm, npx,
 * yarn, bun and corepack. The audit runs as tools/policy/bin/audit.ts (`pnpm audit` cannot be limited to the checked
 * importers; audit.ts).
 */
export const WORKFLOW_PNPM_COMMANDS = ['install', 'lint', 'typecheck', 'test', '-r'];

/** Environment variables that steer the policy tools, Node, pnpm or the shell: a workflow may set them only to these values. */
export const WORKFLOW_ENV_VALUES: Readonly<Record<string, readonly string[]>> = {
  POLICY_BASE_REF: ["${{ format('origin/{0}', github.base_ref || github.ref_name) }}", 'origin/${{ github.base_ref }}'],
  PR_LABELS: ["${{ join(github.event.pull_request.labels.*.name, ',') }}"],
};
export const WORKFLOW_GUARDED_ENV = /^(POLICY_.*|PR_LABELS|NODE_.*|NPM_CONFIG_.*|PNPM_.*|COREPACK_.*|ESLINT_.*|ACTIONS_.*|GITHUB_.*|PATH|BASH_ENV|ENV|LD_PRELOAD)$/i;

/**
 * Trigger filters (review finding R6). ci.yml and guard.yml must run on every pull request: their pull_request and
 * pull_request_target triggers take no branch, tag or path filter, and an activity-type list must keep these types
 * (labeled and unlabeled re-run the drift check when the review label changes). A push trigger may not filter by path
 * or ignore branches, and a branch list must keep the integration branch.
 */
export const PR_TRIGGER_KEYS = ['types'];
export const PR_TRIGGER_TYPES = ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled'];
export const PUSH_TRIGGER_KEYS = ['branches', 'tags'];

/**
 * Steps the CI job may run before its last required step (review finding R6): any other step there could rewrite the
 * policy tools, the installed packages or the runner environment before the checks run. Checkout takes only these
 * inputs (no ref or repository: CI checks the pull request's own merge commit), with persist-credentials false;
 * setup-node takes exactly these values (no package-manager cache); pnpm/action-setup takes no inputs (it reads the
 * pinned `packageManager` of package.json and never runs an install). The job may not set a container or services.
 */
export const CI_CHECKOUT_INPUTS = ['fetch-depth', 'persist-credentials'];
export const CI_SETUP_NODE_INPUTS: Readonly<Record<string, string>> = { 'node-version-file': '.node-version' };

/** Data, never installed, imported or executed: the policy fixtures. */
export const DATA_DIRS = ['tools/policy/test/fixtures/'];

/**
 * .npmrc (review findings m4 and R4): settings that must be present with these values, and the only keys allowed. pnpm
 * 10 reads its settings from .npmrc as well as pnpm-workspace.yaml (pnpm 10.x docs, settings.md). A key is read as the
 * ini parser reads it (quotes removed, a `[]` suffix, a `;` or `#` comment cut off), and must be written plain, as it
 * is read; anything else (another registry, credentials, the script shell, Node options, …) is refused.
 */
export const NPMRC_REQUIRED: Readonly<Record<string, string>> = { 'ignore-scripts': 'true', 'engine-strict': 'true' };
export const NPMRC_ALLOWED = ['ignore-scripts', 'engine-strict', 'save-exact', 'fund'];

/**
 * pnpm-workspace.yaml settings (pnpm 10.x docs, settings.md; each checked against the installed pnpm 10.28.0):
 * minimumReleaseAge (minutes, pnpm ≥ 10.16.0) at least the 14-day policy; strictDepBuilds (≥ 10.3.0) so an install
 * fails on any dependency build script nobody reviewed; blockExoticSubdeps (≥ 10.26.0) so no transitive dependency
 * comes from git or a URL. Any other key (allowBuilds, onlyBuiltDependencies, dangerouslyAllowAllBuilds,
 * ignoreScripts, registry, overrides, packageExtensions, patchedDependencies, pnpmfile, …) is refused.
 */
export const WORKSPACE_REQUIRED: Readonly<Record<string, string>> = { strictDepBuilds: 'true', blockExoticSubdeps: 'true' };
export const WORKSPACE_ALLOWED = ['packages', 'minimumReleaseAge', 'minimumReleaseAgeExclude', 'strictDepBuilds', 'blockExoticSubdeps'];
/** pnpm runs a pnpmfile's hooks during install, and ignoreScripts does not stop it (pnpm 10.x docs): none may exist. */
export const PNPMFILE_PATTERN = /(^|\/)\.?pnpmfile\.[cm]?[jt]s$/;
