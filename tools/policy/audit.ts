// Security audit (B-M30-01 logic 5: "npm audit (or equivalent) on every run"). `pnpm audit` reads the whole lockfile
// and takes no importer filter (pnpm 10.28.0: `--filter` is refused with "Unknown option: 'recursive'"; the 10.x docs
// list none), and on 2026-10-07 it fails on a Zeroed dependency only (uuid < 11.1.1 through apps/web →
// @capacitor/cli → xcode, GHSA-w5hq-g745-h8pq). So this check audits what the other checks cover: every package the
// importers outside the Zeroed manifest reach (allowlist.ts allowlistScope), in every dependency field, with
// `--include-zeroed` for the whole lockfile.
//
// It asks the registry's Bulk Advisory endpoint, the one npm uses (npm/cli docs, commands/npm-audit.md "Bulk
// Advisory Endpoint"): POST <registry>/-/npm/v1/security/advisories/bulk with {"<name>": ["<version>", …]}; the answer
// maps each name to the advisories whose range the posted versions match (checked 2026-10-07: uuid 7.0.3 returned
// GHSA-w5hq-g745-h8pq, uuid 11.1.1 returned {}). Like `--audit-level low`, an advisory of severity low, moderate, high
// or critical is a finding. One request per run, under the owner's rate rule as in age.ts: Retry-After honoured on
// 429, 403 and 5xx, exponential backoff, stop at the third failure.
//
// What a finding does depends on the run (round 1 review F1, red team RT-02; supervisor ruling 1, 2026-10-08). The
// check runs on every run (B-M30-01 logic 5) and always prints what it found, but:
// - on a pull request it fails only for a package version that pull request adds (new against merge-base(base, HEAD)),
//   or when the registry cannot be reached. That is the diff's own fault, which is what a pull request's checks judge;
// - on any other run (a push to the integration branch, the scheduled report) it reports only and exits 0. A push adds
//   no version against its own merge base, so a failure there could only come from an advisory published for a version
//   already in use, or from a registry outage. Neither is that push's fault, and a red run on the integration branch
//   stops every deploy from then on (ops/host/files/usr/local/lib/zeroed/logic.sh commit_verdict), for up to 14 days,
//   because the patched version is usually younger than the 14-day rule;
// - advisories on versions already in use are reported by .github/workflows/audit-schedule.yml, which opens or updates
//   an issue and never fails.
// The mode comes from POLICY_EVENT (GitHub's github.event_name; a pull request cannot set it, config.ts
// WORKFLOW_ENV_VALUES). Unset means a local run, which fails like a pull request's.
import { allowlistScope } from './allowlist.ts';
import { lockIds, RegistryError, REGISTRY_LIMITS, retryAfterMs, type HttpResponse, type Pacing, type RegistryLimits } from './age.ts';
import { DEFAULT_BASE_REF, LOCKFILE, REGISTRY } from './config.ts';
import { finding, formatFindings, type Finding, type Io } from './finding.ts';
import type { Git } from './git.ts';
import { splitId } from './lockfile.ts';
import { readRepo } from './repo.ts';
import { scopeOf } from './scope.ts';

export const BULK_ADVISORY_URL = `${REGISTRY}-/npm/v1/security/advisories/bulk`;
/** Severities that fail the check (`--audit-level low`). */
export const FAILING_SEVERITIES = ['low', 'moderate', 'high', 'critical'];

export interface Advisory { id?: unknown; url?: unknown; title?: unknown; severity?: unknown; vulnerable_versions?: unknown }
export type HttpPost = (url: string, body: string) => Promise<HttpResponse>;

/** `{ name: [versions] }` of the packages in scope, by real package name, names and versions sorted. */
export function auditPayload(keys: Iterable<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of [...keys].sort()) {
    const id = splitId(key);
    if (id === null) continue;
    (out[id[0]] ??= []).push(id[1]);
  }
  return out;
}

/** Findings for the advisories of a Bulk Advisory answer; an answer of another shape is an error (fails closed). */
export function auditFindings(answer: unknown, payload: Readonly<Record<string, string[]>>): Finding[] {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) throw new RegistryError('the advisory answer is not a JSON object', false, null);
  const findings: Finding[] = [];
  for (const [name, list] of Object.entries(answer as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!Array.isArray(list)) throw new RegistryError(`the advisories of ${name} are not a list`, false, null);
    for (const a of list as Advisory[]) {
      const severity = typeof a?.severity === 'string' ? a.severity : 'unknown';
      if (!FAILING_SEVERITIES.includes(severity) && severity !== 'unknown') continue;    // info
      const versions = (payload[name] ?? []).join(', ');
      findings.push(finding('E_AUDIT', name, `${severity} advisory ${String(a?.url ?? a?.id ?? '(no id)')}: ${String(a?.title ?? '')} (vulnerable ${String(a?.vulnerable_versions ?? '?')}; installed ${versions})`));
    }
  }
  return findings;
}

/** POSTs `payload` once, retrying a retryable failure under REGISTRY_LIMITS; returns the parsed answer. */
export async function fetchAdvisories(payload: Readonly<Record<string, string[]>>, post: HttpPost, pacing: Pacing,
  limits: RegistryLimits = REGISTRY_LIMITS): Promise<unknown> {
  const body = JSON.stringify(payload);
  for (let failures = 0; ;) {
    let error: RegistryError;
    try {
      const response = await post(BULK_ADVISORY_URL, body);
      const s = response.status;
      if (s === 200) {
        try {
          return JSON.parse(await response.text()) as unknown;
        } catch {
          throw new RegistryError('the advisory answer is not JSON', false, null);
        }
      }
      error = new RegistryError(`registry answered ${s} for the advisory request`, s === 429 || s === 403 || s >= 500, retryAfterMs(response.headers.get('retry-after'), pacing.nowMs()));
    } catch (e) {
      if (e instanceof RegistryError && !e.retryable) throw e;
      error = e instanceof RegistryError ? e : new RegistryError('the advisory request failed (network)', true, null);
    }
    failures++;
    if (!error.retryable || failures >= limits.maxFailures) throw error;
    const retryAfter = error.retryAfterMs ?? 0;
    if (retryAfter > limits.maxRetryAfterMs) throw new RegistryError(`${error.message}; Retry-After ${retryAfter} ms is longer than ${limits.maxRetryAfterMs} ms, stopping`, false, retryAfter);
    await pacing.sleep(Math.max(limits.baseBackoffMs * 2 ** (failures - 1), retryAfter));
  }
}

/**
 * True when this run only reports: every run but a pull request's (and a local run, where POLICY_EVENT is unset).
 * `--report-only` says the same thing for a run started by hand.
 */
export function reportOnly(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): boolean {
  const event = env['POLICY_EVENT'];
  return argv.includes('--report-only') || (event !== undefined && event !== '' && event !== 'pull_request');
}

/** `name@version` of every package version in `payload` that is not in `known`: what this pull request adds. */
export function addedVersions(payload: Readonly<Record<string, string[]>>, known: ReadonlySet<string>): Set<string> {
  const added = new Set<string>();
  for (const [name, versions] of Object.entries(payload)) {
    for (const v of versions) if (!known.has(`${name}@${v}`)) added.add(`${name}@${v}`);
  }
  return added;
}

/**
 * The findings that block: those for a package of which this change adds a version. The registry's answer does not say
 * which of the posted versions an advisory matched, so a package with one known and one added version counts as
 * blocking (fails closed).
 */
export function blockingFindings(findings: readonly Finding[], payload: Readonly<Record<string, string[]>>, added: ReadonlySet<string>): Finding[] {
  return findings.filter((f) => (payload[f.file] ?? []).some((v) => added.has(`${f.file}@${v}`)));
}

/**
 * Usage: audit.ts [--include-zeroed] [--report-only] [root]. Exit 1 when the registry cannot be read or an advisory
 * matches a package version new against merge-base(POLICY_BASE_REF, HEAD); on a report-only run (see reportOnly) the
 * findings are printed and the exit code is 0.
 */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Io, post: HttpPost,
  pacing: Pacing, git: Git): Promise<number> {
  const includeZeroed = argv.includes('--include-zeroed');
  const report = reportOnly(argv, env);
  const root = argv.find((a) => !a.startsWith('--')) ?? process.cwd();
  const { snapshot, findings: readFindings } = readRepo(root);
  if (readFindings.length > 0 || snapshot.lock === null) {
    io.err(formatFindings(readFindings.length > 0 ? readFindings : [finding('E_LOCK_MISSING', 'pnpm-lock.yaml', 'the committed lockfile is missing')]));
    return 1;
  }
  const payload = auditPayload(allowlistScope(snapshot, scopeOf(includeZeroed)).keys());
  const count = Object.values(payload).reduce((n, v) => n + v.length, 0);
  let findings: Finding[];
  try {
    findings = auditFindings(await fetchAdvisories(payload, post, pacing), payload);
  } catch (e) {
    const message = `${(e as Error).message}; no further requests were made`;
    io.err(formatFindings([finding('E_AUDIT_FETCH', 'registry', report ? `${message}. Reported only: this run is not a pull request's` : message)]));
    return report ? 0 : 1;
  }
  if (findings.length === 0) {
    io.out(`policy: no advisories of severity low or above for ${count} package version(s)${includeZeroed ? ' (Zeroed paths included)' : ''}`);
    return 0;
  }
  if (report) {
    io.err(`${formatFindings(findings)}\npolicy: ${findings.length} advisory finding(s) in ${count} package version(s), reported only: this run is not a pull request's`);
    return 0;
  }
  const baseRef = env['POLICY_BASE_REF'] ?? DEFAULT_BASE_REF;
  const mergeBase = git.mergeBase(baseRef);
  if (mergeBase === null) {
    io.err(`${formatFindings([...findings, finding('E_BASE_REF', baseRef, `no merge base between "${baseRef}" and HEAD, so the versions this change adds are unknown; fetch the base branch or set POLICY_BASE_REF`)])}`);
    return 1;
  }
  const blocking = blockingFindings(findings, payload, addedVersions(payload, lockIds(git.show(mergeBase, LOCKFILE))));
  if (blocking.length > 0) {
    io.err(`${formatFindings(findings)}\npolicy: ${blocking.length} of ${findings.length} advisory finding(s) are for package version(s) this change adds against ${baseRef}`);
    return 1;
  }
  io.out(`${formatFindings(findings)}\npolicy: ${findings.length} advisory finding(s) in ${count} package version(s), none for a version this change adds against ${baseRef}; `
    + 'they are reported by .github/workflows/audit-schedule.yml');
  return 0;
}
