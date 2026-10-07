// 14-day adoption rule (B-M30-01 logic 3; ARCH 12.3 POLICY; TH-37, TH-40): every package version the pull request
// adds to the lockfile must have been published at least MIN_AGE_DAYS before today, unless DEPENDENCIES.md lists it
// under "Age exceptions" (security fixes after review). Versions already in the base branch's lockfile passed this
// check when they were added and only grow older, so they are not fetched again: a change that leaves the lockfile
// alone makes no registry request at all.
//
// Publish times are the `time` field of the full packument (GET https://registry.npmjs.org/<name>; read 2026-10-06:
// the abbreviated `application/vnd.npm.install-v1+json` document has no `time`). The owner's rate rule (2026-10-06)
// applies, as npm documents no numeric limit for registry reads: one request in flight, at least
// REGISTRY_LIMITS.minIntervalMs between requests, Retry-After honoured on 429, 403 and 5xx, exponential backoff, and
// the whole check stops at the third failure. This check needs the network, so it runs in CI, not in `pnpm lint`.
// pnpm's own minimumReleaseAge (pnpm-workspace.yaml) applies the same rule when pnpm resolves; a frozen install does
// not re-check versions already in the lockfile (checked with pnpm 10.28.0 on this repository), so this check stays.
//
// The same documents give each version's manifest, so this check also refuses a new version that declares an install
// script (`preinstall`, `install` or `postinstall`, or `gypfile: true`, which makes the package manager run node-gyp):
// pnpm's v9 lockfile records no install-script flag (C01's npm lockfile had `hasInstallScript`), and the installed
// scan (installed.ts) sees only what installs on CI's platform, not a macOS- or Windows-only optional package.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGE_EXCEPTION_HEADER, parseTable } from './allowlist.ts';
import { LOCKFILE, MIN_AGE_DAYS, REGISTRY } from './config.ts';
import { finding, formatFindings, type Finding, type Io } from './finding.ts';
import type { Git } from './git.ts';
import { readLock, thirdPartyEntries } from './lockfile.ts';

const DAY_MS = 86_400_000;
export type PublishTimes = Record<string, string>;
/** What one registry document says: publish times, and the install scripts each version declares. */
export interface Packument { time: PublishTimes; installScripts: Record<string, string[]> }
export type FetchTimes = (name: string) => Promise<Packument>;
/** Manifest scripts that run on install, and the flag that makes the package manager run node-gyp rebuild. */
export const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall'];

/** Registry read limits (owner rule 2026-10-06). `maxFailures` counts every failed request of one run. */
export const REGISTRY_LIMITS = { minIntervalMs: 500, maxFailures: 3, baseBackoffMs: 2_000, maxRetryAfterMs: 120_000 };
export type RegistryLimits = typeof REGISTRY_LIMITS;

/** Waiting and the time source, injected so tests run without real delays or the wall clock. */
export interface Pacing { sleep(ms: number): Promise<void>; nowMs(): number }

export function checkAges(entries: ReadonlyArray<{ name: string; version: string }>, times: ReadonlyMap<string, PublishTimes>,
  exceptions: ReadonlySet<string>, nowMs: number): Finding[] {
  const findings: Finding[] = [];
  for (const { name, version } of entries) {
    const id = `${name}@${version}`;
    if (exceptions.has(id)) continue;
    const published = times.get(name)?.[version];
    const publishedMs = published === undefined ? Number.NaN : Date.parse(published);
    if (Number.isNaN(publishedMs)) {
      findings.push(finding('E_AGE_UNKNOWN', LOCKFILE, `${id}: the registry has no publish time`));
    } else if (nowMs - publishedMs < MIN_AGE_DAYS * DAY_MS) {
      findings.push(finding('E_TOO_NEW', LOCKFILE, `${id} was published ${published}, less than ${MIN_AGE_DAYS} days ago`));
    }
  }
  return findings;
}

/** A new version whose registry manifest declares an install script fails (E_INSTALL_SCRIPT), on every platform. */
export function checkInstallScripts(entries: ReadonlyArray<{ name: string; version: string }>, docs: ReadonlyMap<string, Packument>): Finding[] {
  const findings: Finding[] = [];
  for (const { name, version } of entries) {
    const scripts = docs.get(name)?.installScripts[version] ?? [];
    if (scripts.length > 0) {
      findings.push(finding('E_INSTALL_SCRIPT', LOCKFILE, `${name}@${version} declares ${scripts.join(', ')} in its registry manifest; install scripts are not allowed`));
    }
  }
  return findings;
}

/** `name@version` rows of the DEPENDENCIES.md "Age exceptions" table; rows without a reason or reviewer are findings. */
export function ageExceptions(md: string): { ids: Set<string>; findings: Finding[] } {
  const ids = new Set<string>();
  const findings: Finding[] = [];
  for (const { cells: [id = '', reason = '', reviewer = ''], line } of parseTable(md, AGE_EXCEPTION_HEADER) ?? []) {
    if (/^@?[^@\s]+@\d+\.\d+\.\d+\S*$/.test(id) && reason !== '' && reviewer !== '') ids.add(id);
    else findings.push(finding('E_AGE_EXCEPTION_ROW', `DEPENDENCIES.md:${line}`, 'an age exception needs name@version, a reason and a reviewer'));
  }
  return { ids, findings };
}

/** A failed registry read. `retryable`: 429, 403, 5xx or a network error; `retryAfterMs`: the server's Retry-After. */
export class RegistryError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(message: string, retryable: boolean, retryAfterMs: number | null) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After (RFC 9110 10.2.3: delay-seconds or an HTTP date) in milliseconds from `nowMs`; null if absent or invalid. */
export function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** Packument URL; a scoped name keeps its "@" and escapes the "/" as npm does: @solana/kit → @solana%2Fkit. */
export function packumentUrl(name: string): string {
  return `${REGISTRY}${encodeURIComponent(name).replace(/^%40/, '@')}`;
}

/** The parts of a fetch Response this check reads. */
export interface HttpResponse { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
export type HttpGet = (url: string) => Promise<HttpResponse>;

/** Install scripts of each version in a packument's `versions` (unreadable entries count as none; times decide). */
export function installScriptsOf(versions: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof versions !== 'object' || versions === null) return out;
  for (const [v, manifest] of Object.entries(versions as Record<string, unknown>)) {
    if (typeof manifest !== 'object' || manifest === null) continue;
    const m = manifest as { scripts?: unknown; gypfile?: unknown };
    const scripts = typeof m.scripts === 'object' && m.scripts !== null ? Object.keys(m.scripts).filter((k) => INSTALL_SCRIPT_KEYS.includes(k)) : [];
    if (m.gypfile === true) scripts.push('gypfile');
    if (scripts.length > 0) out[v] = scripts;
  }
  return out;
}

/** Publish times from the registry packument's `time` field, and each version's install scripts; one GET per call. */
export function registryTimes(get: HttpGet, nowMs: () => number): FetchTimes {
  return async (name) => {
    let response: HttpResponse;
    try {
      response = await get(packumentUrl(name));
    } catch {
      throw new RegistryError(`registry request for ${name} failed (network)`, true, null);
    }
    const s = response.status;
    if (s !== 200) {
      throw new RegistryError(`registry answered ${s} for ${name}`, s === 429 || s === 403 || s >= 500, retryAfterMs(response.headers.get('retry-after'), nowMs()));
    }
    let doc: { time?: unknown; versions?: unknown } | null;
    try {
      doc = JSON.parse(await response.text()) as { time?: unknown; versions?: unknown } | null;
    } catch {
      throw new RegistryError(`registry document for ${name} is not JSON`, false, null);
    }
    const time = doc?.time;
    if (typeof time !== 'object' || time === null) throw new RegistryError(`registry document for ${name} has no publish times`, false, null);
    return {
      time: Object.fromEntries(Object.entries(time).filter((e): e is [string, string] => typeof e[1] === 'string')),
      installScripts: installScriptsOf(doc?.versions),
    };
  };
}

/**
 * Fetches `names` one at a time, at least `limits.minIntervalMs` apart. A retryable failure waits for the longer of
 * the exponential backoff (baseBackoffMs × 2^(failures − 1)) and the server's Retry-After, then tries again. The run
 * stops, with nothing more requested, at the first failure that is not retryable, at a Retry-After longer than
 * maxRetryAfterMs, or at the maxFailures-th failure of the run.
 */
export async function fetchSequential(names: readonly string[], fetchTimes: FetchTimes, pacing: Pacing,
  limits: RegistryLimits = REGISTRY_LIMITS): Promise<Map<string, Packument>> {
  const out = new Map<string, Packument>();
  let last = Number.NEGATIVE_INFINITY;
  let failures = 0;
  for (const name of names) {
    for (;;) {
      const wait = last + limits.minIntervalMs - pacing.nowMs();
      if (wait > 0) await pacing.sleep(wait);
      last = pacing.nowMs();
      try {
        out.set(name, await fetchTimes(name));
        break;
      } catch (e) {
        failures++;
        if (!(e instanceof RegistryError) || !e.retryable || failures >= limits.maxFailures) throw e;
        const retryAfter = e.retryAfterMs ?? 0;
        if (retryAfter > limits.maxRetryAfterMs) {
          throw new RegistryError(`${e.message}; Retry-After ${retryAfter} ms is longer than ${limits.maxRetryAfterMs} ms, stopping`, false, retryAfter);
        }
        await pacing.sleep(Math.max(limits.baseBackoffMs * 2 ** (failures - 1), retryAfter));
      }
    }
  }
  return out;
}

/** `name@version` of every third-party package in a lockfile text (real names, so an alias counts as its package). */
export function lockIds(text: string | null): Set<string> {
  const read = readLock(text ?? '');
  return 'error' in read ? new Set() : new Set(thirdPartyEntries(read.lock).map(({ name, version }) => `${name}@${version}`));
}

export async function main(root: string, nowMs: number, io: Io, fetchTimes: FetchTimes, git: Git, baseRef: string,
  pacing: Pacing): Promise<number> {
  if (!git.hasRef(baseRef)) {
    io.err(formatFindings([finding('E_BASE_REF', baseRef, `base ref "${baseRef}" is not available; fetch it or set POLICY_BASE_REF`)]));
    return 1;
  }
  const read = readLock(readFileSync(join(root, LOCKFILE), 'utf8'));
  if ('error' in read) {
    io.err(formatFindings([finding('E_LOCK_PARSE', LOCKFILE, read.error)]));
    return 1;
  }
  const known = lockIds(git.show(baseRef, LOCKFILE));
  const entries = thirdPartyEntries(read.lock).map(({ name, version }) => ({ name, version }))
    .filter((e) => !known.has(`${e.name}@${e.version}`));
  const { ids, findings: rowFindings } = ageExceptions(readFileSync(join(root, 'DEPENDENCIES.md'), 'utf8'));
  const names = [...new Set(entries.map((e) => e.name))].sort();
  let docs: Map<string, Packument>;
  try {
    docs = await fetchSequential(names, fetchTimes, pacing);
  } catch (e) {
    io.err(formatFindings([...rowFindings, finding('E_AGE_FETCH', 'registry', `${(e as Error).message}; no further requests were made`)]));
    return 1;
  }
  const times = new Map([...docs].map(([n, d]) => [n, d.time]));
  const findings = [...rowFindings, ...checkAges(entries, times, ids, nowMs), ...checkInstallScripts(entries, docs)];
  if (findings.length > 0) {
    io.err(formatFindings(findings));
    return 1;
  }
  io.out(`policy: ${entries.length} package version(s) new against ${baseRef} (${names.length} package(s) fetched), each at least ${MIN_AGE_DAYS} days old, none with an install script`);
  return 0;
}
