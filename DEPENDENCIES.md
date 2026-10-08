# Dependencies

The dependency policy (B-M30-01, ARCH 12.3) and the allowlist of every third-party package the checked workspace projects install from `pnpm-lock.yaml`. Owner: the supervisor (AGENTS.md file ownership). No new package without the supervisor's OK and a row here. Ported from Snipe-solana card C01 (npm) to this repository's pnpm 10 toolchain (docs/MIGRATION.md "Toolchain"); every pnpm setting below was checked in the pnpm 10.x docs (`pnpm/pnpm.io` `versioned_docs/version-10.x`) and against the installed pnpm 10.28.0.

## Scope

Old Zeroed code stays as it is (docs/MIGRATION.md: "not deleted, not run on the server, and not fixed further"). The checks that would flag it today skip exactly the files on the committed manifest `tools/policy/zeroed-files.txt` (`tools/policy/config.ts` `ZEROED_FILES_MANIFEST`: the 2,318 files the Zeroed folders `apps/`, `brand/`, `docs/evidence/`, `docs/handover/`, `docs/research/`, `ops/`, `research/` and the Zeroed packages `packages/{backtest,core,ops,runner,worker}` held in the integration branch at `c045c18a`), the Zeroed workflows (`ZEROED_WORKFLOWS`) and the `historical-data` job of `ci.yml` (`ZEROED_JOBS`): the import, source-type, code-loading, symbolic-link, lint, pump.fun-host and secrets checks, the allowlist and the audit. **A file that is not on the manifest is checked, wherever it sits**, so new Blueprint code under `apps/`, `ops/` or `research/` gets every check (round 1 review F4, red team RT-01; it used to be skipped with the folder). Round 3 (ruling 3.1) splits the checks: the **structure rules** (ESLint, import paths, source types, code loading) also skip everything under the Zeroed-only package folders `packages/{backtest,core,ops,runner,worker}/` and `apps/web/`, new files included; the **safety checks** (pump.fun hosts, undeclared and forbidden imports) read every new file, those folders included, and the lines each old Zeroed file gained since `merge-base(base, HEAD)`, so an edit to old Zeroed code is checked while its old lines stay quiet. A new workspace package under `apps/` is refused outright (`E_NEW_PACKAGE_DIR`): new packages go under `packages/`. The manifest is a guarded file, so changing it needs the review label. Every other path, including any new one, is checked. The manifest, lockfile-source, typosquat, install-script, age and configuration checks cover the whole repository. `node tools/policy/bin/check.ts --include-zeroed` and `node tools/policy/bin/audit.ts --include-zeroed` report what the scoped checks would find in Zeroed's paths.

## Policy

| Rule | Enforced by |
|---|---|
| Exact version pins in every `package.json`; `@bot/*` packages only as `workspace:*` (pnpm 10 would otherwise resolve them from the registry, where the `@bot` scope is not ours); the lockfile (`pnpm-lock.yaml` v9) is committed and every package in it comes from the npm registry with an sha512 integrity hash and nothing else (no tarball URL, git, directory or file source); no other package manager's lockfile; no overrides, package extensions, patches or pnpmfile checksum in the lockfile | `pnpm lint` (`tools/policy`: `E_PIN`, `E_INTERNAL_NOT_LINKED`, `E_LOCK_*`, `E_OTHER_LOCKFILE`); `pnpm install --frozen-lockfile` fails when a `package.json` and the lockfile disagree |
| An alias (`"x": "npm:y@1.0.0"`, written `y@1.0.0` in the lockfile) is checked under both names by every name-based check (the `@solana/web3.js` ban, known-malicious versions, typosquats, the allowlist, the 14-day rule); a manifest may not declare one | `E_WEB3_BANNED`, `E_KNOWN_MALICIOUS`, `E_TYPOSQUAT`, `E_NOT_ALLOWLISTED`, `E_TOO_NEW`, `E_PIN` |
| A pull request that changes `pnpm-lock.yaml`, a policy file (`pnpm-workspace.yaml`, `package.json`, `.npmrc`, `.node-version`, `vitest.config.ts`, `eslint.config.*` and `tsconfig*.json` at any depth, `tools/**`, `.github/**`) or a file a check reads as reviewed input (this file, with its reviewer cells and age exceptions, and each frozen package's `FREEZE.json` and `CHANGELOG.md`, with the sign-offs) fails CI until a reviewer has read that diff and added the label bound to the content of all those files, `deps-reviewed:<first 32 hex digits of their hash>`. Reviewer cells, age exceptions and sign-offs are therefore filled in before the label is added: any later edit to them makes the label stale. CI computes the label on the pull request's merge commit and the failing step prints it; `node tools/policy/bin/drift.ts --print-label` gives the same value only on a branch that already contains the latest base branch. The label counts **only on the run whose own `labeled` event added it** (`PR_LABEL_ADDED`), so it is always newer than the head commit it clears (red team RT-03): after a push that changes a guarded file the supervisor adds it again, removing and re-adding it when the hash did not change. A push that changes no guarded file needs no label. Who adds the label is not checked: every agent and the owner use the same GitHub account, so the supervisor adds it after reading the diff (AGENTS.md). The guard workflow is **not** in this repository: a `pull_request_target` run reports against the base branch's newest commit, so a failed guard run would stop every deploy (round 1 review F2); a follow-up card tests one on a scratch repository or teaches the deploy gate to ignore it, and until then the check runs only on the pull request's own copy | CI step `tools/policy/bin/drift.ts` in `ci.yml` (`E_LOCK_DRIFT`, `E_POLICY_DRIFT`) |
| Installs never run lifecycle scripts: the root `.npmrc` keeps `ignore-scripts=true` and `engine-strict=true` and sets no key but those, `save-exact` and `fund`; keys are read as the ini parser reads them and must be written plain; no other `.npmrc`. `pnpm-workspace.yaml` may set only `packages`, `minimumReleaseAge`, `minimumReleaseAgeExclude`, `strictDepBuilds: true` and `blockExoticSubdeps: true` (so no `allowBuilds`, `onlyBuiltDependencies`, `dangerouslyAllowAllBuilds`, registry, overrides or pnpmfile); no pnpmfile and no other `pnpm-workspace.yaml`. With `ignore-scripts=true`, pnpm 10.28.0 neither runs a dependency's install script nor fails the install on it, even with `strictDepBuilds` (checked on this repository), so CI reads every installed package from disk right after the install, and the age check reads every new version's registry manifest, which also covers optional packages for other platforms. `.node-version` holds the exact Node CI runs (the host's pinned 22.23.3) and `engines.node` is `>=<floor> <23` with the floor no higher than it. No install-time script in our own `package.json` files | `E_NPMRC`, `E_PNPM_CONFIG`, `E_PNPMFILE`, `E_ENGINES`, `E_LIFECYCLE_SCRIPT`, `E_INSTALL_SCRIPTS_ENABLED`, `E_LOCK_NOT_FROZEN`; CI step `tools/policy/bin/installed.ts` (`E_INSTALL_SCRIPT` for a `preinstall`, `install` or `postinstall` script or a `binding.gyp`); `tools/policy/bin/age.ts` (`E_INSTALL_SCRIPT` from the registry manifest) |
| CI holds no secrets: read-only `permissions` (the scheduled advisory report is the one workflow that may declare a write, and only `issues: write`), no `secrets.*`, `persist-credentials: false`, actions pinned by full commit SHA (no local `./` actions), no `pull_request_target` or `workflow_run` trigger. Workflows are parsed: `ci.yml` runs on every pull request (no branch, tag or path filter); each required step runs as its own unconditional step (no `if`, `continue-on-error`, `working-directory`, `\|\| true` or `defaults`), in order, in the job named `check` (the deploy gate keys on that name; its only condition is the draft skip), without a container or services, and before the last required step that job runs only the required steps, `actions/checkout` (no `ref` or `repository`), `pnpm/action-setup` (no inputs) and `actions/setup-node` from `.node-version` (no cache); no run step names `GITHUB_ENV` or `GITHUB_PATH`; the advisory report runs only on a schedule and sets `continue-on-error` on every step, so it can never put a failed run on the default branch's newest commit; pnpm runs only as `install --frozen-lockfile`, `lint`, `typecheck`, `test` or `-r`, never with `--config.*`, and never npm, npx, pnpx, yarn, bun or corepack | `E_WORKFLOW_*`, `E_ACTION_NOT_PINNED`, `E_CI_STEP_*`, `E_CI_JOB_NAME`, `E_AUDIT_SCHEDULE`, `E_NEW_PACKAGE_DIR`, `E_GUARD*` (the guard's rules stay for the follow-up card) |
| Every package name is on the allowlist below with purpose, licence (as the installed package declares it; the v9 lockfile records none) and the name of the reviewer who read the diff ("pending" fails) | `E_NOT_ALLOWLISTED`, `E_ALLOWLIST_ROW`, `E_ALLOWLIST_REVIEWER`; CI step `installed.ts` (`E_LICENCE_MISMATCH`) |
| Known malicious names and compromised versions are refused; names that imitate `bs58`, `base-x`, `raydium`, `dexscreener`, `solana`, `pumpfun`, `async-mutex`, `ethers` or `web3.js` need a reviewed change to the check (TH-37, TH-38, TH-40, TH-41) | `E_KNOWN_MALICIOUS`, `E_TYPOSQUAT` |
| A version is adopted only once it is at least 14 days old, after a changelog and diff review; a security fix may skip the wait only through a row under "Age exceptions". pnpm applies the same rule whenever it resolves (`minimumReleaseAge: 20160` minutes), and CI reads publish times for every version new against the lockfile at `merge-base(base, HEAD)` (not the base tip, so a newer push to the base cannot fail an older commit's run: round 1 review F5), one registry request at a time at least 500 ms apart, honours `Retry-After`, backs off exponentially and stops at the third failure. `minimumReleaseAgeExclude` lists only exact versions that are in the base branch's lockfile or under "Age exceptions" | CI step `tools/policy/bin/age.ts` (`E_TOO_NEW`, `E_AGE_FETCH`); `E_AGE_EXCLUDE` |
| `@bot/types` and `@bot/signer` have no third-party package in their production closure; `@bot/sentinel` depends only on internal packages and `@solana/kit` | `E_THIRD_PARTY_RUNTIME`, `E_SENTINEL_DEP` |
| Every module reference in the checked source (static import, `export from`, `import()`, `require()`, `typeof import()`) is a `node:` built-in, a relative path inside its own package, or a package the importing manifest declares (production fields for production code). `tools/` is a workspace project only so that `@typescript-eslint/parser` gets the TypeScript 6 it supports; its files are checked as root-level code against `tools/package.json` and the root manifest. `@bot/types` and `@bot/signer` production code imports only `node:` built-ins and `@bot/*`; a computed specifier is refused. Workspace packages may not import `node:module` or use anything that loads code the check cannot follow: `getBuiltinModule`, `dlopen`, `eval`, `Function`, a `.constructor` read, a bare `require`, or a timer given a string (ESLint `no-eval`, `no-new-func`, `no-implied-eval` as well). A test loads every package module under a resolve hook with code generation from strings disabled and fails on any other load. Not covered: a property name built at run time or an alias (`const p = process; p[name]`) whose load runs only later, and code run through `worker_threads`, `child_process` or `vm`; review catches those. Under `packages/` and `tools/` every checked module is `.ts`, and ESLint lints every JS and TS extension. No symbolic link outside Zeroed's paths: a link in the working tree or in the index fails the check, which then stops before reading through it; no check reads through a link in Zeroed's paths either | `E_UNDECLARED_IMPORT`, `E_THIRD_PARTY_RUNTIME`, `E_IMPORT_*`, `E_CODE_LOADING`, `E_SOURCE_TYPE`, `E_SYMLINK`; `tools/policy/test/load-packages.test.ts` |
| `pnpm lint` loads only the reviewed `eslint.config.mjs` (`eslint --config`, which switches off ESLint's per-directory config lookup); any other `eslint.config.*` is refused | `E_ESLINT_CONFIG` |
| `@solana/web3.js` is banned in `@bot/engine` and `@bot/signer`, directly or transitively, by manifest, lockfile and import (LD-05, LD-36) | `E_WEB3_BANNED`; ESLint `no-restricted-imports` |
| No third-party bot repositories and no git or URL dependencies (TH-41) | `E_LOCK_SOURCE`, `E_PIN`; pnpm `blockExoticSubdeps` |
| No request to a pump.fun-operated host (the domain and every subdomain) from bot or research code (owner rule A02): a pump.fun host after `//`, any subdomain of it (with or without a trailing dot), or the bare domain in any letter case where a host is written (after a quote or backtick, after `=`, after `: ` or at the start of a line, ending at a quote, `/`, `:`, `?`, `#`, a comma or the end of the line), (red team RT-04), after whitespace when `/` follows, or as an argument of `curl` or `wget` run as a command (red team RT2-02), with whitespace around `=` and `:`, followed by `;`, `)`, `,`, `:port`, a quote or the end of the line (whitespace before any of these too; plain whitespace then a word counts only as a shell argument, ruling 6.5), and as any argument in shell files, on lines with `\u`, `\x`, `%`, octal `\NNN`, Python `\N{…}` and HTML entity escapes decoded, then folded with NFKC and with `。`, `．` and `｡` read as `.` (rulings 5.4, 6.2), with `:` starting a value only after a key (at the start of a line, after a list dash, `{` or `,`) and a shell argument inside a quoted string that holds other words read as prose (ruling 7.3), with a line ending in `\` and the lines of a YAML folded block also read joined (ruling 7.2), in every text file: binary files (a binary extension and binary content: a NUL byte in the first 8,000 bytes or the format's magic number), Markdown, non-code under `docs/` (code there is read) and the evidence files named in `tools/policy/hosts.ts` `EVIDENCE_FILES` are not read as text (ruling 3.2); a binary file is searched as latin1 bytes for the domain written literally (ruling 7.1); a binary name on text content, or a NUL byte in any file whose extension is not on `BINARY_EXTENSIONS`, is `E_BINARY_SOURCE`, and the file is read as text (rulings 5.1, 6.1, 7.1). A new compressed archive not named in `ARCHIVE_FILES` with its reason is `E_ARCHIVE` (ruling 7.1). This is a tripwire for literal hosts and their common encodings, not a sandbox: a host built on purpose at run time is for review and the red team (ruling 7.0). Old Zeroed files are read only on the lines they gained since the merge base (ruling 3.1). Pinned IDLs on GitHub and SDK test oracles from npm are not pump.fun hosts | `E_PUMP_FUN_HOST`, `E_BINARY_SOURCE`, `E_ARCHIVE` |
| A security audit on every CI run: the registry's Bulk Advisory endpoint (the one npm uses) for every package the checked workspace projects install; an advisory of severity low or above is a finding and is always printed. On a pull request it fails the step when it matches a package version that pull request adds (new against `merge-base(base, HEAD)`), or when the registry cannot be read. On every other run (a push, the schedule) it reports only and exits 0: a push adds no version of its own, so a failure there could only come from an advisory for a version already in use or a registry outage, neither of which is that push's doing, and a red run on the integration branch would stop every deploy for as long as it took to adopt a patch (round 1 review F1, red team RT-02). Advisories for versions already in use are reported by `.github/workflows/audit-schedule.yml`, which runs daily on the default branch, opens or updates one issue and can never fail (every step sets `continue-on-error`). `pnpm audit` cannot be limited to the checked projects and fails today on a Zeroed dependency only (below) | CI step `tools/policy/bin/audit.ts` (`E_AUDIT`, `E_AUDIT_FETCH`); `E_AUDIT_SCHEDULE` for the report workflow |
| A CycloneDX SBOM per release: `tools/policy/bin/sbom.ts` writes a CycloneDX 1.6 document of the production closure of the checked workspace projects, and `.github/workflows/sbom.yml` builds it on every `v*` tag and keeps it as a workflow artifact. pnpm 10.28.0 has no `sbom` command (the docs give it as v11.0.0), so the document is written here. A failed SBOM run marks its own tagged commit red and the deploy gate skips that commit: a release with no SBOM should not deploy, so that is accepted (round 1 review F6, red team RT-07; supervisor ruling 6, recorded in docs/DECISIONS.md) | CI workflow `sbom.yml` (`E_SBOM` from `sbom.ts`) |
| No `.gitattributes` may set `-diff`, `binary`, `diff=`, `-text`, `working-tree-encoding=`, `filter=` or `ident` (they would hide an edit from the added-lines scan or change what git stores; ruling 6.4); `.gitattributes` is guarded at any depth. No job `name:` in any workflow may hold an expression (the deploy gate matches check runs by name). No workflow, Zeroed's included, may use a YAML anchor, alias or merge key (ruling 6.3) | `E_GITATTRIBUTES`, `E_JOB_NAME_EXPR`, `E_YAML_ANCHOR` |
| A frozen package (`@bot/types`) is hashed over `package.json`, every file under `src/`, its `tsconfig.json` and every config that one extends (`tsconfig.bot.json`), and the `compilerOptions` and `extends` chain of the repository root `tsconfig.json` (not its `include`, `exclude`, `files` or `references`, so adding a package there needs no bump; round 4 ruling), and the root `typescript` version (ruling 5.6): a compiler option decides what the frozen types mean, so a change to one needs the version bump, the `CHANGELOG.md` entry and both group leads' sign-offs, like a change to the types themselves (red team RT-06) | `pnpm lint` (`E_FROZEN_CHANGED`, `E_FREEZE_VERSION`, `E_FREEZE_BUMP`, `E_FREEZE_SIGNOFF`, `E_CHANGELOG`) |
| Secrets scan of every checked file (fixtures included; binary files are read for their UTF-8 text and, when they hold NUL bytes, their UTF-16 text) and of the CI test log; a keypair array is found in decimal or hex, spread over lines and with comments between items; reviewed false positives are listed by fingerprint in `tools/policy/secret-allowlist.json` | `E_SECRET` |

The checks have self-tests: `tools/policy/test` commits deliberately bad changes to a copy of a good repository and asserts that the check fails with the expected code.

## Allowlist

Reviewer: whoever read the dependency diff and added the `deps-reviewed:<hash>` label. "pending" (or an empty cell) fails `pnpm lint` until that name is filled in. The builder who proposes a package never fills this cell (AGENTS.md: builders never approve their own work). Z01's builder recorded where each approval came from, for the supervisor to confirm when adding the label: "in the integration branch before Z01" (the package was already installed), or "Z01 brief" (the supervisor pre-approved `eslint` 10.11.0, `@typescript-eslint/parser` 8.70.1 and `fast-check` 4.10.2 and their dependencies). `typescript` 6.0.3 (the parser's TypeScript peer) was approved by the supervisor on 2026-10-07, limited to `tools/`.

| Package | Purpose | Licence | Reviewer |
|---|---|---|---|
| `@cacheable/memory` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@cacheable/utils` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@eslint-community/eslint-utils` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@eslint-community/regexpp` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@eslint/config-array` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@eslint/config-helpers` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@eslint/core` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@eslint/object-schema` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@eslint/plugin-kit` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@humanfs/core` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@humanfs/node` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@humanfs/types` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@humanwhocodes/module-importer` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@humanwhocodes/retry` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `@jridgewell/resolve-uri` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@jridgewell/sourcemap-codec` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@jridgewell/trace-mapping` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@keyv/bigmap` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@keyv/serialize` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@oxc-project/types` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-android-arm-eabi` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-android-arm64` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-darwin-arm64` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-darwin-x64` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-freebsd-x64` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-linux-arm-gnueabihf` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-linux-arm64-gnu` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-linux-arm64-musl` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-linux-ppc64-gnu` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-linux-s390x-gnu` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-linux-x64-gnu` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-linux-x64-musl` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-openharmony-arm64` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-win32-arm64-msvc` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/binding-win32-x64-msvc` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@rolldown/pluginutils` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@types/chai` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@types/deep-eql` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@types/esrecurse` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@types/estree` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint`, `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@types/json-schema` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@types/node` | Node.js 22 type definitions for the type checker (dev only) | MIT | supervisor (in the integration branch before Z01) |
| `@typescript-eslint/parser` | TypeScript parser for ESLint and the import check (dev only) | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@typescript-eslint/project-service` | Transitive (dev only), required by `@typescript-eslint/parser` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@typescript-eslint/scope-manager` | Transitive (dev only), required by `@typescript-eslint/parser` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@typescript-eslint/tsconfig-utils` | Transitive (dev only), required by `@typescript-eslint/parser` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@typescript-eslint/types` | Transitive (dev only), required by `@typescript-eslint/parser` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@typescript-eslint/typescript-estree` | Transitive (dev only), required by `@typescript-eslint/parser` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@typescript-eslint/visitor-keys` | Transitive (dev only), required by `@typescript-eslint/parser` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `@typescript/typescript-aix-ppc64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-darwin-arm64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-darwin-x64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-freebsd-arm64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-freebsd-x64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-linux-arm` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-linux-arm64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-linux-loong64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-linux-mips64el` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-linux-ppc64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-linux-riscv64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-linux-s390x` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-linux-x64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-netbsd-arm64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-netbsd-x64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-openbsd-arm64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-openbsd-x64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-sunos-x64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-win32-arm64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@typescript/typescript-win32-x64` | Transitive (dev only), required by `typescript` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `@vitest/mocker` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `@vitest/spy` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `acorn` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `acorn-jsx` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `ajv` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `assertion-error` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `balanced-match` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (in the integration branch before Z01) |
| `brace-expansion` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (in the integration branch before Z01) |
| `cacheable` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `chai` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `cross-spawn` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (in the integration branch before Z01) |
| `debug` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (in the integration branch before Z01) |
| `deep-is` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `detect-libc` | Transitive (dev only), required by `vitest` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `es-module-lexer` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `escape-string-regexp` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `eslint` | Linter for `pnpm lint` and the bot rule package (dev only) | MIT | supervisor (Z01 brief, 2026-10-07) |
| `eslint-scope` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | BSD-2-Clause | supervisor (Z01 brief, 2026-10-07) |
| `eslint-visitor-keys` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | Apache-2.0 | supervisor (Z01 brief, 2026-10-07) |
| `espree` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | BSD-2-Clause | supervisor (Z01 brief, 2026-10-07) |
| `esquery` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | BSD-3-Clause | supervisor (Z01 brief, 2026-10-07) |
| `esrecurse` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | BSD-2-Clause | supervisor (Z01 brief, 2026-10-07) |
| `estraverse` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | BSD-2-Clause | supervisor (Z01 brief, 2026-10-07) |
| `estree-walker` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `esutils` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | BSD-2-Clause | supervisor (Z01 brief, 2026-10-07) |
| `expect-type` | Transitive (dev only), required by `vitest` | Apache-2.0 | supervisor (in the integration branch before Z01) |
| `fast-check` | Property-based tests (ARCH 16.2) (dev only) | MIT | supervisor (Z01 brief, 2026-10-07) |
| `fast-deep-equal` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `fast-json-stable-stringify` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `fast-levenshtein` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `fdir` | Transitive (dev only), required by `@typescript-eslint/parser`, `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `file-entry-cache` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `find-up` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `flat-cache` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `flatted` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | ISC | supervisor (Z01 brief, 2026-10-07) |
| `fsevents` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `glob-parent` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | ISC | supervisor (Z01 brief, 2026-10-07) |
| `hashery` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `hookified` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `ignore` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `imurmurhash` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `is-extglob` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `is-glob` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `isexe` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | ISC | supervisor (in the integration branch before Z01) |
| `json-schema-traverse` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `json-stable-stringify-without-jsonify` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `keyv` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `levn` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `lightningcss` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-android-arm64` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-darwin-arm64` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-darwin-x64` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-freebsd-x64` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-linux-arm-gnueabihf` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-linux-arm64-gnu` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-linux-arm64-musl` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-linux-x64-gnu` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-linux-x64-musl` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-win32-arm64-msvc` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `lightningcss-win32-x64-msvc` | Transitive (dev only), required by `vitest` | MPL-2.0 | supervisor (in the integration branch before Z01) |
| `locate-path` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `magic-string` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `minimatch` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | BlueOak-1.0.0 | supervisor (in the integration branch before Z01) |
| `ms` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (in the integration branch before Z01) |
| `nanoid` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `natural-compare` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `obug` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `optionator` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `p-limit` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `p-locate` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `path-exists` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `path-key` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (in the integration branch before Z01) |
| `picocolors` | Transitive (dev only), required by `vitest` | ISC | supervisor (in the integration branch before Z01) |
| `picomatch` | Transitive (dev only), required by `@typescript-eslint/parser`, `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `postcss` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `prelude-ls` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `punycode` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `pure-rand` | Transitive (dev only), required by `fast-check` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `qified` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `rolldown` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `semver` | Transitive (dev only), required by `@typescript-eslint/parser` | ISC | supervisor (in the integration branch before Z01) |
| `shebang-command` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (in the integration branch before Z01) |
| `shebang-regex` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (in the integration branch before Z01) |
| `source-map-js` | Transitive (dev only), required by `vitest` | BSD-3-Clause | supervisor (in the integration branch before Z01) |
| `std-env` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `tinybench` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `tinyexec` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `tinyglobby` | Transitive (dev only), required by `@typescript-eslint/parser`, `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `ts-api-utils` | Transitive (dev only), required by `@typescript-eslint/parser` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `type-check` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `typescript` | Type checker: 7.0.2 for `pnpm typecheck` and every package's `tsc` (in the integration branch before Z01). 6.0.3 (published 2026-04-16, Apache-2.0) only in `tools/`, as the TypeScript peer of `@typescript-eslint/parser`: its peer range is below 6.1.0 and TypeScript 7 has no JS compiler API; used only by ESLint and the import-graph check (`tools/eslint/test/typescript6.test.ts`); remove it once typescript-eslint supports TypeScript 7 (dev only) | Apache-2.0 | supervisor (7.0.2 in the integration branch before Z01; 6.0.3 approved 2026-10-07, limited to `tools/`) |
| `undici-types` | Transitive (dev only), required by `@types/node`, `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `uri-js` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | BSD-2-Clause | supervisor (Z01 brief, 2026-10-07) |
| `vite` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `vitest` | Test runner for `pnpm test` (dev only) | MIT | supervisor (in the integration branch before Z01) |
| `which` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | ISC | supervisor (in the integration branch before Z01) |
| `why-is-node-running` | Transitive (dev only), required by `vitest` | MIT | supervisor (in the integration branch before Z01) |
| `word-wrap` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `yocto-queue` | Transitive (dev only), required by `@typescript-eslint/parser`, `eslint` | MIT | supervisor (Z01 brief, 2026-10-07) |
| `zod` | Runtime schema check of every dashboard view model in `@bot/contract` (B-M28-01; UI.md UI-F32), imported by the dashboard and the server; production dependency. 4.6.5, published 2026-09-13 (24 days old on 2026-10-07), no dependencies of its own, no install script (npm registry, read 2026-10-07) | MIT | supervisor (Z02 brief, 2026-10-08) |

## Built-in modules instead of packages

Decisions where a Node built-in replaces a third-party package. Each was checked on the pinned Node release (`.node-version`).

| Need | Decision | Evidence |
|---|---|---|
| SQLite library (CA-33, B-M24-01 spike; VERIFY A-45) | Node's built-in `node:sqlite` on the pinned Node 22.23.3 (`docs/DECISIONS.md` row "Node: stay on Node 22", line 119; SPEC-B B-M24-01 cites VF-08, Node 24 ≥ 24.15.0: A-45 passed on 22.23.3 with no flags, so a spec note follows in Z0D-2). No package, no install script, no downloaded binary. Only `packages/engine/src/m24/` and its tests may import it (`tools/policy`, `E_SQLITE_OUTSIDE_M24`). | nodejs/node `v22.23.3` `doc/api/sqlite.md` (read 2026-10-07): `DatabaseSync` (v22.5.0), `database.isTransaction` (v22.16.0), `statement.setReadBigInts` (v22.5.0), `sqlite.backup()` (v22.16.0); module "Stability: 1.1 - Active development". `packages/engine/test/m24/sqlite-verify.test.ts` re-checks explicit transactions, WAL, a read-only reader during a write and the online backup on every CI run. Node 22 prints an `ExperimentalWarning` once per process. **Write latency on the 2 GB host: pending** (a server check, listed in `HANDOVER.md`): `node packages/engine/test/m24/write-latency.bench.ts <data dir>/bench.db 2000`; switch rule (D06): a 10-row transaction p99 above 20 ms for 24 h moves to the fallback binding. |

## Age exceptions

Security fixes adopted before they are 14 days old. Each row needs `name@version`, the reason (advisory) and the reviewer.

| Package | Reason | Reviewer |
|---|---|---|

## Release-age exclusions

`pnpm-workspace.yaml` `minimumReleaseAgeExclude`: versions already in the integration branch's lockfile before Z01 set `minimumReleaseAge`, younger than 14 days on 2026-10-07, so `pnpm add` and `pnpm install` would otherwise refuse the lockfile they are in. Exact versions only; each may be removed once it is 14 days old (the last on 2026-10-16). Checked by `E_AGE_EXCLUDE` against the base branch's lockfile.

| Version | Published (UTC) |
|---|---|
| `@oxc-project/types@0.152.0` | 2026-09-28 |
| `@rolldown/binding-android-arm-eabi@1.2.12` | 2026-09-30 |
| `@rolldown/binding-android-arm64@1.2.12` | 2026-09-30 |
| `@rolldown/binding-darwin-arm64@1.2.12` | 2026-09-30 |
| `@rolldown/binding-darwin-x64@1.2.12` | 2026-09-30 |
| `@rolldown/binding-freebsd-x64@1.2.12` | 2026-09-30 |
| `@rolldown/binding-linux-arm-gnueabihf@1.2.12` | 2026-09-30 |
| `@rolldown/binding-linux-arm64-gnu@1.2.12` | 2026-09-30 |
| `@rolldown/binding-linux-arm64-musl@1.2.12` | 2026-09-30 |
| `@rolldown/binding-linux-ppc64-gnu@1.2.12` | 2026-09-30 |
| `@rolldown/binding-linux-s390x-gnu@1.2.12` | 2026-09-30 |
| `@rolldown/binding-linux-x64-gnu@1.2.12` | 2026-09-30 |
| `@rolldown/binding-linux-x64-musl@1.2.12` | 2026-09-30 |
| `@rolldown/binding-openharmony-arm64@1.2.12` | 2026-09-30 |
| `@rolldown/binding-win32-arm64-msvc@1.2.12` | 2026-09-30 |
| `@rolldown/binding-win32-x64-msvc@1.2.12` | 2026-09-30 |
| `@types/node@22.20.5` | 2026-10-01 |
| `@vitest/mocker@5.0.3` | 2026-09-30 |
| `@vitest/spy@5.0.3` | 2026-09-30 |
| `chai@6.3.0` | 2026-09-30 |
| `framer-motion@14.0.0` | 2026-10-02 |
| `motion@14.0.0` | 2026-10-02 |
| `motion-dom@14.0.0` | 2026-10-02 |
| `motion-utils@14.0.0` | 2026-10-02 |
| `rolldown@1.2.12` | 2026-09-30 |
| `source-map-js@1.2.2` | 2026-09-30 |
| `std-env@4.3.0` | 2026-09-29 |
| `vite@8.3.2` | 2026-10-01 |
| `vitest@5.0.3` | 2026-09-30 |

## Known findings

Found by Z01's checks on 2026-10-07 and not fixed here; each is open with the supervisor.

| Finding | Where | Why it does not fail CI |
|---|---|---|
| `fsevents@2.3.3` declares `install: node-gyp rebuild` (`gypfile: true`) in its registry manifest | Optional, macOS only; pulled in by `vitest` (already in the integration branch) | `ignore-scripts=true` stops it; it never installs on the Linux CI or host; the age check reads install scripts only for versions new against the base branch |
| `uuid@7.0.3`: moderate advisory GHSA-w5hq-g745-h8pq (vulnerable < 11.1.1) | Zeroed: `apps/web` → `@capacitor/cli` → `xcode` | Zeroed's dependencies are outside the audit's scope |
| 29 versions in the lockfile were younger than 14 days when Z01 set the rule (table above) | Mostly `vitest` 5.0.3, `vite` 8.3.2 and their dependencies; `motion` 14.0.0 (Zeroed app) | Already in the base branch; pnpm excludes the exact versions |
