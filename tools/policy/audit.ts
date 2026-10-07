// Security audit (B-M30-01 logic 5: "npm audit (or equivalent) on every run"). `pnpm audit` reads the whole lockfile
// and takes no importer filter (pnpm 10.28.0: `--filter` is refused with "Unknown option: 'recursive'"; the 10.x docs
// list none), and on 2026-10-07 it fails on a Zeroed dependency only (uuid < 11.1.1 through apps/web →
// @capacitor/cli → xcode, GHSA-w5hq-g745-h8pq). So this check audits what the other checks cover: every package the
// importers outside config.ts ZEROED_PATHS reach (allowlist.ts allowlistScope), in every dependency field, with
// `--include-zeroed` for the whole lockfile.
//
// It asks the registry's Bulk Advisory endpoint, the one npm uses (npm/cli docs, commands/npm-audit.md "Bulk
// Advisory Endpoint"): POST <registry>/-/npm/v1/security/advisories/bulk with {"<name>": ["<version>", …]}; the answer
// maps each name to the advisories whose range the posted versions match (checked 2026-10-07: uuid 7.0.3 returned
// GHSA-w5hq-g745-h8pq, uuid 11.1.1 returned {}). Like `--audit-level low`, an advisory of severity low, moderate, high
// or critical fails the check. One request per run, under the owner's rate rule as in age.ts: Retry-After honoured on
// 429, 403 and 5xx, exponential backoff, stop at the third failure; any failure fails the check (closed).
import { allowlistScope } from './allowlist.ts';
import { RegistryError, REGISTRY_LIMITS, retryAfterMs, type HttpResponse, type Pacing, type RegistryLimits } from './age.ts';
import { REGISTRY } from './config.ts';
import { finding, formatFindings, type Finding, type Io } from './finding.ts';
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

/** Usage: audit.ts [--include-zeroed] [root]. Exit 0 when no advisory of severity low or above matches, 1 otherwise. */
export async function main(argv: readonly string[], io: Io, post: HttpPost, pacing: Pacing): Promise<number> {
  const includeZeroed = argv[0] === '--include-zeroed';
  const root = (includeZeroed ? argv[1] : argv[0]) ?? process.cwd();
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
    io.err(formatFindings([finding('E_AUDIT_FETCH', 'registry', `${(e as Error).message}; no further requests were made`)]));
    return 1;
  }
  if (findings.length > 0) {
    io.err(`${formatFindings(findings)}\npolicy: ${findings.length} advisory finding(s) in ${count} package version(s)`);
    return 1;
  }
  io.out(`policy: no advisories of severity low or above for ${count} package version(s)${includeZeroed ? ' (Zeroed paths included)' : ''}`);
  return 0;
}
