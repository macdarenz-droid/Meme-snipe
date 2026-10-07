// GitHub Actions checks (B-M30-01 logic 2 and 5; C01 review findings m1 and M3). Workflows are parsed (yaml.ts; a
// file the reader cannot follow fails), then:
// - every action and reusable workflow is pinned by a full commit SHA (a local `./` action is refused: nothing pins
//   it); the token is read-only; no secrets are used. The one exception is the scheduled advisory report, which may
//   declare `issues: write` and nothing else (config.ts WORKFLOW_WRITE_PERMISSIONS), because it opens or updates the
//   issue that carries the advisories for versions already in use;
// - that report must exist, may run only on a schedule (and by hand) and every step of it sets continue-on-error, so
//   it can never put a failed run on the default branch's newest commit (supervisor ruling 1);
// - no workflow runs on pull_request_target or workflow_run (they run with the base repository's token and secrets),
//   except the guard, which uses pull_request_target to run the base branch's drift check against the pull request;
// - run steps call pnpm only as `pnpm install --frozen-lockfile`, the root scripts (lint, typecheck, test), `pnpm
//   audit` or a recursive `pnpm -r` run of the packages' own scripts, never with a `--config.` override, and never npm,
//   npx, pnpx, yarn, bun or corepack (C01 allowed npm only; this repository installs with pnpm, MIGRATION.md
//   "Toolchain"); `defaults` (which would change every step's shell or directory) is refused, and the
//   variables that steer the policy tools, Node, npm, ESLint or the runner keep their reviewed values; no run step
//   names GITHUB_ENV or GITHUB_PATH (which change the environment of every later step) or the removed set-env and
//   add-path commands (review finding R6). That is a name filter: a write by indirection (`v=GITHUB_; v+=ENV`) passes
//   it, so the guarantee for the checks rests on E_CI_STEP_EXTRA below and on the review label that guards .github
//   (C01 red-team round 3, finding A3);
// - ci.yml runs on every pull request (no branch, tag or path filter) and runs each required step (config.ts
//   CI_REQUIRED_STEPS) as its own unconditional step, in order, in the job named `check` (the deploy gate keys on that
//   name), without a container or services and with no condition but the draft skip of config.ts CI_JOB_IF; before
//   the last required step that job runs nothing but the required steps, each with the environment variables it needs
//   (config.ts CI_REQUIRED_STEP_ENV), actions/checkout (no ref or repository),
//   actions/setup-node from .node-version and pnpm/action-setup with no inputs (review finding R6);
// - Zeroed's own workflows (config.ts ZEROED_WORKFLOWS) and Zeroed's jobs inside a checked one (ZEROED_JOBS: their
//   own keys and steps) are not checked; any other workflow is, and so are the whole file's lines (secrets, write
//   permissions) and top-level keys;
// - guard.yml runs on every pull request and only checks out the base branch into base/ and the pull request's merge
//   commit into pr/ (data), input by input, sets up Node from base/.node-version, and runs the base copy of the drift
//   check in pr/, in a job without a condition, container or services.
import {
  AUDIT_SCHEDULE_WORKFLOW, CI_CHECKOUT_INPUTS, CI_JOB, CI_JOB_IF, CI_REQUIRED_STEP_ENV, CI_REQUIRED_STEPS, CI_SETUP_NODE_INPUTS, CI_WORKFLOW, GUARD_BASE_CHECKOUT, GUARD_COMMAND,
  GUARD_PR_CHECKOUT, GUARD_SETUP_NODE, GUARD_WORKFLOW, INTEGRATION_BRANCH, PR_TRIGGER_KEYS, PR_TRIGGER_TYPES, PUSH_TRIGGER_KEYS,
  WORKFLOW_ENV_VALUES, WORKFLOW_GUARDED_ENV, WORKFLOW_PNPM_COMMANDS, WORKFLOW_WRITE_PERMISSIONS,
} from './config.ts';
import { finding, type Finding } from './finding.ts';
import type { RepoSnapshot } from './repo.ts';
import { scopeOf, type Scope } from './scope.ts';
import { parseYaml, type YamlMap, type YamlValue } from './yaml.ts';

/** `owner/repo[/path]@<40 hex>`: a full commit SHA, which a tag or branch move cannot change. */
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;
/** Ways a workflow reads secrets: an expression, an `if:` condition, or passing them all to a reusable workflow. */
const SECRETS_USE = [/\$\{\{[^}]*\bsecrets\b/, /^\s*(?:-\s*)?if:.*\bsecrets\b/, /\bsecrets:\s*inherit\b/];
/** Triggers that run with the base repository's token and secrets. */
const PRIVILEGED_TRIGGERS = ['pull_request_target', 'workflow_run'];
const OTHER_RUNNERS = /(^|[\s;&|(`])(npm|npx|pnpx|yarn|bunx?|corepack)(?=$|[\s;&|)`])/m;
/**
 * Names of the runner's environment files, which change every later step, and of the removed commands that did the
 * same. A name filter, not a proof: a run step that builds the name at run time passes it. What protects the checks is
 * E_CI_STEP_EXTRA (before the last required step the CI job runs only the required steps, checkout and setup-node)
 * and the review label on .github/** (C01 red-team round 3, finding A3).
 */
const ENV_FILE_WRITES = /GITHUB_ENV|GITHUB_PATH|_runner_file_commands|::(set-env|add-path)\b/;
/** Job keys that run the steps elsewhere or skip them: refused on the CI and guard jobs. */
const JOB_RELOCATORS = ['container', 'services'];
/** A pnpm call: its subcommand (group 2) and the rest of the command up to the next ;, &, | or line end (group 3). */
const PNPM_CALL = /(^|[\s;&|(`])pnpm(?=$|[\s;&|)`])(?:[ \t]+([^\s;&|)`]+))?([^\n;&|]*)/gm;

const isMap = (v: YamlValue | undefined): v is YamlMap => typeof v === 'object' && v !== null && !Array.isArray(v);
const mapOf = (v: YamlValue | undefined): YamlMap => (isMap(v) ? v : {});
const textOf = (v: YamlValue | undefined): string | null => (typeof v === 'string' ? v : null);

interface Step { job: string; index: number; step: YamlMap; where: string }

function stepsOf(file: string, doc: YamlMap): Step[] {
  return Object.entries(mapOf(doc['jobs'])).flatMap(([job, j]) => {
    const steps = mapOf(j)['steps'];
    return (Array.isArray(steps) ? steps : []).flatMap((step, index) =>
      (isMap(step) ? [{ job, index, step, where: `${file} jobs.${job}.steps[${index}]` }] : []));
  });
}

/** Scopes `file` may declare as `write` (config.ts WORKFLOW_WRITE_PERMISSIONS); none for any other workflow. */
function allowedWrites(file: string): string[] {
  return [...(WORKFLOW_WRITE_PERMISSIONS[file] ?? [])];
}

function readOnly(p: YamlValue | undefined, file: string): boolean {
  const writes = allowedWrites(file);
  return p === 'read-all' || (isMap(p) && Object.entries(p).every(([scope, v]) => v === 'read' || v === 'none' || writes.includes(`${scope}: ${String(v)}`)));
}

/** Trigger names of an `on:` value (a name, a list of names or a map). */
export function triggers(on: YamlValue | undefined): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((t): t is string => typeof t === 'string');
  return Object.keys(mapOf(on));
}

function checkLines(file: string, text: string, findings: Finding[]): void {
  const writes = allowedWrites(file);
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '');
    const where = `${file}:${i + 1}`;
    if (SECRETS_USE.some((re) => re.test(line))) findings.push(finding('E_WORKFLOW_SECRETS', where, 'CI holds no secrets; do not reference secrets'));
    if ((/:\s*write\b|write-all/.test(line)) && !writes.includes(line.trim())) {
      findings.push(finding('E_WORKFLOW_PERMISSIONS', where, `CI permissions must be read-only${writes.length > 0 ? ` (this workflow may declare only ${writes.join(', ')})` : ''}`));
    }
  });
}

function checkUses(where: string, uses: YamlValue | undefined, findings: Finding[]): void {
  const u = textOf(uses);
  if (u !== null && !PINNED_ACTION.test(u)) {
    findings.push(finding('E_ACTION_NOT_PINNED', where, u.startsWith('./') ? `"${u}" is a local action or workflow: nothing pins it and it can run anything` : `"${u}" is not pinned by a full commit SHA`));
  }
}

/** True when `w` holds exactly the given inputs with these values. */
function inputsAre(w: YamlMap, expected: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(w);
  return keys.length === Object.keys(expected).length && keys.every((k) => w[k] === expected[k]);
}

function checkEnv(where: string, env: YamlValue | undefined, findings: Finding[]): void {
  for (const [key, value] of Object.entries(mapOf(env))) {
    if (WORKFLOW_GUARDED_ENV.test(key) && !(WORKFLOW_ENV_VALUES[key] ?? []).includes(String(value))) {
      findings.push(finding('E_WORKFLOW_ENV', where, `${key} steers the policy tools, Node, npm or the shell; it may only be set to its reviewed value`));
    }
  }
}

export function checkRun(where: string, run: string, findings: Finding[]): void {
  if (OTHER_RUNNERS.test(run)) findings.push(finding('E_WORKFLOW_COMMAND', where, 'npm, npx, pnpx, yarn, bun and corepack may not run in CI; installs and scripts go through pnpm'));
  for (const m of run.matchAll(PNPM_CALL)) {
    const sub = m[2];
    if (sub === undefined || !WORKFLOW_PNPM_COMMANDS.includes(sub)) {
      findings.push(finding('E_WORKFLOW_COMMAND', where, `"pnpm ${sub ?? ''}" is not allowed; CI runs only pnpm ${WORKFLOW_PNPM_COMMANDS.join(', ')}`));
    } else if (sub === 'install' && !/(^|\s)--frozen-lockfile(\s|$)/.test(m[3] as string)) {
      findings.push(finding('E_LOCK_NOT_FROZEN', where, 'pnpm installs must pass --frozen-lockfile, so CI installs exactly the reviewed lockfile'));
    }
    if (/(^|\s)--config\./.test(m[3] as string)) findings.push(finding('E_WORKFLOW_COMMAND', where, 'pnpm --config.* overrides the reviewed settings; not allowed'));
  }
  if (/--no-frozen-lockfile|frozen-lockfile[= ]+false/.test(run)) findings.push(finding('E_LOCK_NOT_FROZEN', where, 'the frozen lockfile may not be switched off'));
  if (/--no-ignore-scripts|ignore-scripts[= ]+false/.test(run)) findings.push(finding('E_INSTALL_SCRIPTS_ENABLED', where, 'lifecycle scripts may not be switched back on'));
  if (ENV_FILE_WRITES.test(run)) findings.push(finding('E_WORKFLOW_COMMAND', where, 'GITHUB_ENV, GITHUB_PATH, set-env and add-path change the environment of every later step; not allowed'));
}

/**
 * Filters that would let a pull request skip the workflow (review finding R6): `trigger` must exist, may set only
 * PR_TRIGGER_KEYS, and a types list must keep PR_TRIGGER_TYPES.
 */
function checkTrigger(file: string, on: YamlValue | undefined, trigger: string, findings: Finding[]): void {
  if (!triggers(on).includes(trigger)) {
    findings.push(finding('E_WORKFLOW_TRIGGER', file, `the workflow must run on ${trigger}`));
    return;
  }
  const config = mapOf(mapOf(on)[trigger]);
  const extra = Object.keys(config).filter((k) => !PR_TRIGGER_KEYS.includes(k));
  if (extra.length > 0) findings.push(finding('E_WORKFLOW_TRIGGER', file, `${trigger} may not filter by ${extra.join(', ')}; the workflow must run on every pull request`));
  const types = config['types'];
  if (types !== undefined && !(Array.isArray(types) && PR_TRIGGER_TYPES.every((t) => types.includes(t)))) {
    findings.push(finding('E_WORKFLOW_TRIGGER', file, `${trigger} types must include ${PR_TRIGGER_TYPES.join(', ')}`));
  }
}

function checkPushTrigger(file: string, on: YamlValue | undefined, findings: Finding[]): void {
  const push = mapOf(on)['push'];
  if (!isMap(push)) return;
  const extra = Object.keys(push).filter((k) => !PUSH_TRIGGER_KEYS.includes(k));
  if (extra.length > 0) findings.push(finding('E_WORKFLOW_TRIGGER', file, `push may not filter by ${extra.join(', ')}`));
  const branches = push['branches'];
  if (branches !== undefined && !(Array.isArray(branches) && branches.includes(INTEGRATION_BRANCH))) {
    findings.push(finding('E_WORKFLOW_TRIGGER', file, `push branches must include the integration branch ${INTEGRATION_BRANCH}`));
  }
}

/**
 * Job keys that make a required job (the CI job, the guard) conditional, non-blocking, or run elsewhere. `allowedIf`
 * is the one condition the job may carry (the CI job's draft skip), or null.
 */
function checkJobKeys(where: string, job: YamlMap, findings: Finding[], allowedIf: string | null = null): void {
  for (const key of ['if', 'continue-on-error', ...JOB_RELOCATORS]) {
    if (key === 'if' && allowedIf !== null && job['if'] === allowedIf) continue;
    if (key in job) findings.push(finding('E_CI_STEP_DISABLED', where, `the job running the required steps may not set "${key}"${key === 'if' && allowedIf !== null ? ` (other than the draft skip ${allowedIf})` : ''}`));
  }
}

/** Why a required step would not enforce anything: the keys that make it conditional, non-blocking or relocated. */
function disabledBy(step: YamlMap, shell: string | undefined): string[] {
  const reasons = ['if', 'continue-on-error', 'working-directory'].filter((k) => k in step);
  const s = textOf(step['shell']);
  if (shell === undefined ? s !== null && s !== 'bash' : s !== shell) reasons.push(`shell (must be ${shell ?? 'unset or bash'})`);
  return reasons;
}

function checkRequiredSteps(doc: YamlMap, findings: Finding[]): void {
  const steps = stepsOf(CI_WORKFLOW, doc);
  const jobs = Object.keys(mapOf(doc['jobs']));
  const matchesOf = (job: string): Array<Step | undefined> =>
    CI_REQUIRED_STEPS.map((spec) => steps.find((s) => s.job === job && textOf(s.step['run'])?.trim() === spec.run));
  const job = jobs.map((j) => ({ j, n: matchesOf(j).filter(Boolean).length })).sort((a, b) => b.n - a.n)[0]?.j ?? '';
  const matches = matchesOf(job);
  if (job !== CI_JOB) {
    findings.push(finding('E_CI_JOB_NAME', `${CI_WORKFLOW} jobs.${job}`, `the required steps must run in the job named "${CI_JOB}": the deploy gate (ops/host/files/usr/local/lib/zeroed/logic.sh) counts only that check run`));
  }
  checkJobKeys(`${CI_WORKFLOW} jobs.${job}`, mapOf(mapOf(doc['jobs'])[job]), findings, CI_JOB_IF);
  let last = -1;
  CI_REQUIRED_STEPS.forEach((spec, i) => {
    const s = matches[i];
    if (s === undefined) {
      findings.push(finding('E_CI_STEP_MISSING', CI_WORKFLOW, `the CI workflow must run "${spec.run}" as its own step`));
      return;
    }
    const reasons = disabledBy(s.step, spec.shell);
    if (reasons.length > 0) findings.push(finding('E_CI_STEP_DISABLED', s.where, `"${spec.run}" must run unconditionally and block the job; remove or fix: ${reasons.join(', ')}`));
    const env = mapOf(s.step['env']);
    for (const [key, value] of Object.entries(CI_REQUIRED_STEP_ENV[spec.run] ?? {})) {
      if (env[key] !== value) findings.push(finding('E_CI_STEP_ENV', s.where, `"${spec.run}" must set ${key} to "${value}": the check reads GitHub's own event facts from it`));
    }
    if (s.index < last) findings.push(finding('E_CI_STEP_ORDER', s.where, `"${spec.run}" runs before a step it must follow (order: ${CI_REQUIRED_STEPS.map((r) => r.run).join(' → ')})`));
    last = Math.max(last, s.index);
  });
  for (const s of steps) {
    if (s.job !== job || s.index >= last || matches.includes(s)) continue;
    const uses = textOf(s.step['uses']) ?? '';
    const w = mapOf(s.step['with']);
    const ok = Object.keys(s.step).every((k) => ['name', 'uses', 'with'].includes(k)) && (uses.startsWith('actions/checkout@')
      ? w['persist-credentials'] === 'false' && Object.keys(w).every((k) => CI_CHECKOUT_INPUTS.includes(k))
      : uses.startsWith('actions/setup-node@') ? inputsAre(w, CI_SETUP_NODE_INPUTS)
        : uses.startsWith('pnpm/action-setup@') && !('with' in s.step));
    if (!ok) {
      findings.push(finding('E_CI_STEP_EXTRA', s.where, 'before the last required step the CI job may only run the required steps, actions/checkout (fetch-depth and persist-credentials: false only), actions/setup-node (node-version-file .node-version only, no cache) and pnpm/action-setup (no inputs); another step could change the files or tools the checks use'));
    }
  }
}

function checkGuard(doc: YamlMap, findings: Finding[]): void {
  const on = triggers(doc['on']);
  if (on.length !== 1 || on[0] !== 'pull_request_target') {
    findings.push(finding('E_GUARD', GUARD_WORKFLOW, 'the guard must run on pull_request_target only (the base branch\'s copy runs)'));
  } else {
    checkTrigger(GUARD_WORKFLOW, doc['on'], 'pull_request_target', findings);
  }
  for (const [name, job] of Object.entries(mapOf(doc['jobs']))) checkJobKeys(`${GUARD_WORKFLOW} jobs.${name}`, mapOf(job), findings);
  let ran = false;
  for (const { step, where } of stepsOf(GUARD_WORKFLOW, doc)) {
    const uses = textOf(step['uses']) ?? '';
    const run = textOf(step['run']);
    const w = mapOf(step['with']);
    let ok: boolean;
    if (run !== null) {
      ok = run.trim() === GUARD_COMMAND && step['working-directory'] === 'pr' && !('if' in step) && !('continue-on-error' in step) && !('shell' in step);
      ran ||= ok;
    } else {
      const plain = !('if' in step) && !('continue-on-error' in step);
      ok = plain && (uses.startsWith('actions/checkout@') ? inputsAre(w, GUARD_BASE_CHECKOUT) || inputsAre(w, GUARD_PR_CHECKOUT)
        : uses.startsWith('actions/setup-node@') && inputsAre(w, GUARD_SETUP_NODE));
    }
    if (!ok) {
      findings.push(finding('E_GUARD', where, `the guard may only check out the base branch into base/ and the pull request's merge commit into pr/ (persist-credentials: false, no repository), set up Node from base/.node-version (no other input), and run "${GUARD_COMMAND}" in pr/`));
    }
  }
  if (!ran) findings.push(finding('E_GUARD', GUARD_WORKFLOW, `the guard must run "${GUARD_COMMAND}" in working-directory pr`));
}

/**
 * The scheduled advisory report (config.ts AUDIT_SCHEDULE_WORKFLOW; supervisor ruling 1). It must exist, so the
 * advisories the `check` job no longer fails on are still reported, it may run only on a schedule (and by hand), so no
 * pull request can start it, and every step must carry `continue-on-error: true`, so no failure of its own can put a
 * red run on the default branch's newest commit and stop the deploy gate.
 */
function checkAuditSchedule(doc: YamlMap, findings: Finding[]): void {
  const on = triggers(doc['on']);
  if (!on.includes('schedule') || on.some((t) => t !== 'schedule' && t !== 'workflow_dispatch')) {
    findings.push(finding('E_AUDIT_SCHEDULE', AUDIT_SCHEDULE_WORKFLOW, 'the advisory report runs on schedule (and workflow_dispatch), and on no other trigger'));
  }
  for (const { step, where } of stepsOf(AUDIT_SCHEDULE_WORKFLOW, doc)) {
    if (step['continue-on-error'] !== 'true') {                         // the reader gives every scalar as a string
      findings.push(finding('E_AUDIT_SCHEDULE', where, 'every step of the advisory report sets "continue-on-error: true": a failed run of it would land on the '
        + 'default branch\'s newest commit and the deploy gate would refuse that commit'));
    }
  }
}

function checkWorkflow(file: string, text: string, findings: Finding[], scope: Scope): YamlMap | null {
  checkLines(file, text, findings);
  let doc: YamlValue;
  try {
    doc = parseYaml(text);
  } catch (e) {
    findings.push(finding('E_WORKFLOW_PARSE', file, `${(e as Error).message}; the policy cannot tell what this workflow runs`));
    return null;
  }
  if (!isMap(doc)) {
    findings.push(finding('E_WORKFLOW_PARSE', file, 'a workflow must be a mapping'));
    return null;
  }
  if (!readOnly(doc['permissions'], file)) findings.push(finding('E_WORKFLOW_PERMISSIONS', file, 'set a top-level "permissions:" block that is read-only'));
  for (const t of triggers(doc['on'])) {
    if (PRIVILEGED_TRIGGERS.includes(t) && !(file === GUARD_WORKFLOW && t === 'pull_request_target')) {
      findings.push(finding('E_WORKFLOW_TRIGGER', file, `"${t}" runs with the base repository's token and secrets; not allowed`));
    }
  }
  checkEnv(`${file} env`, doc['env'], findings);
  for (const [name, job] of [['', doc] as const, ...Object.entries(mapOf(doc['jobs'])).filter(([n]) => scope.job(file, n))]) {
    const j = mapOf(job);
    const where = name === '' ? file : `${file} jobs.${name}`;
    if ('defaults' in j) findings.push(finding('E_WORKFLOW_DEFAULTS', where, '"defaults" changes the shell or directory of every step; set them per step'));
    if (name !== '') {
      if ('permissions' in j && !readOnly(j['permissions'], file)) findings.push(finding('E_WORKFLOW_PERMISSIONS', where, 'job permissions must be read-only'));
      checkEnv(`${where}.env`, j['env'], findings);
      checkUses(where, j['uses'], findings);
    }
  }
  for (const { step, where } of stepsOf(file, doc).filter((st) => scope.job(file, st.job))) {
    checkUses(where, step['uses'], findings);
    checkEnv(`${where}.env`, step['env'], findings);
    const run = textOf(step['run']);
    if (run !== null) checkRun(where, run, findings);
  }
  return doc;
}

export function checkWorkflows(snapshot: RepoSnapshot, scope: Scope = scopeOf(false)): Finding[] {
  const findings: Finding[] = [];
  const docs = new Map<string, YamlMap | null>();
  for (const w of snapshot.workflows) if (scope(w.file)) docs.set(w.file, checkWorkflow(w.file, w.text, findings, scope));
  const ci = docs.get(CI_WORKFLOW);
  if (ci === undefined) findings.push(finding('E_CI_MISSING', CI_WORKFLOW, 'the CI workflow is missing'));
  else if (ci !== null) {
    checkTrigger(CI_WORKFLOW, ci['on'], 'pull_request', findings);
    checkPushTrigger(CI_WORKFLOW, ci['on'], findings);
    checkRequiredSteps(ci, findings);
  }
  // The guard is not in this repository (config.ts GUARD_WORKFLOW, supervisor ruling 2 for round 1 review F2): a
  // pull_request_target run reports against the base branch's newest commit, so a failure would stop every deploy. Its
  // rules stay, so the follow-up card can bring a tested guard back; while the file is absent they check nothing.
  const guard = docs.get(GUARD_WORKFLOW);
  if (guard !== undefined && guard !== null) checkGuard(guard, findings);
  const schedule = docs.get(AUDIT_SCHEDULE_WORKFLOW);
  if (schedule === undefined) {
    findings.push(finding('E_AUDIT_SCHEDULE', AUDIT_SCHEDULE_WORKFLOW, 'the scheduled advisory report is missing: with the audit step failing only on the '
      + 'versions a pull request adds, it is what reports an advisory for a version already in use (supervisor ruling 1)'));
  } else if (schedule !== null) checkAuditSchedule(schedule, findings);
  return findings;
}
