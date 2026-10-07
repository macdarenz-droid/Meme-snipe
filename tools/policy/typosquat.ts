// Known-malicious packages and look-alike names (B-M30-01 logic 3; TH-37, TH-38, TH-40, TH-41).
import { INTERNAL_SCOPE, LOCKFILE } from './config.ts';
import { finding, type Finding } from './finding.ts';
import { aliasTarget, thirdPartyEntries } from './lockfile.ts';
import { DEPENDENCY_FIELDS, type RepoSnapshot } from './repo.ts';

/** Package names reported as malicious in the fact register (TH-38, TH-41). Never allowed. */
export const MALICIOUS_NAMES = [
  'solana-systemprogram-utils', '@async-mutex/mutex', 'dexscreener', 'solana-transaction-toolkit', 'solana-stable-web-huks',
  'raydium-bs58', 'base-x-64', 'bs58-basic', 'base_xd', 'ethersproject-wallet', 'crypto-layout-utils', 'bs58-encrypt-utils',
  'bs58-encrypt-utils-1.0.3',
];

/** Package versions reported as compromised in the fact register (TH-37, TH-40). Never allowed. */
export const MALICIOUS_VERSIONS = [
  '@solana/web3.js@1.95.6', '@solana/web3.js@1.95.7', 'debug@4.4.2', 'chalk@5.6.1', 'color@5.0.1', 'duckdb@1.3.3',
  '@duckdb/node-api@1.3.3', '@duckdb/node-bindings@1.3.3', '@duckdb/duckdb-wasm@1.29.2',
];

/** Names targeted by the campaigns in TH-38 and TH-41, and the genuine packages that carry them. */
export const TARGETS = ['bs58', 'base-x', 'raydium', 'dexscreener', 'solana', 'pumpfun', 'async-mutex', 'ethers', 'web3.js'];
export const GENUINE = ['bs58', 'base-x', 'async-mutex', 'ethers'];
/** Official scopes: names inside them are not look-alikes (other checks still apply). Our own @bot/* packages are
 * workspace links (lockfile check E_INTERNAL_NOT_LINKED), so they are not look-alikes either. */
export const OFFICIAL_SCOPES = ['@solana/'];

export function normalise(name: string): string {
  return name.toLowerCase().replace(/[@/._-]/g, '');
}

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** The targeted name `name` imitates, or null. A look-alike contains a target or is within 2 edits of one. */
export function lookalikeOf(name: string): string | null {
  if (GENUINE.includes(name) || OFFICIAL_SCOPES.some((s) => name.startsWith(s)) || name.startsWith(INTERNAL_SCOPE)) return null;
  const n = normalise(name);
  for (const target of TARGETS) {
    const t = normalise(target);
    if (n.includes(t) || editDistance(n, t) <= 2) return target;
  }
  return null;
}

function checkName(name: string, version: string | null, file: string, findings: Finding[]): void {
  if (MALICIOUS_NAMES.includes(name)) {
    findings.push(finding('E_KNOWN_MALICIOUS', file, `${name} is a known malicious package (TH-38, TH-41)`));
    return;
  }
  if (version !== null && MALICIOUS_VERSIONS.includes(`${name}@${version}`)) {
    findings.push(finding('E_KNOWN_MALICIOUS', file, `${name}@${version} is a known compromised version (TH-37, TH-40)`));
  }
  const target = lookalikeOf(name);
  if (target !== null) findings.push(finding('E_TYPOSQUAT', file, `${name} looks like "${target}", a name targeted by typosquatting campaigns (TH-38)`));
}

/** Checks every name a dependency answers to: the declared name, and the real package of an `npm:` alias. */
export function checkTyposquats(snapshot: RepoSnapshot): Finding[] {
  const findings: Finding[] = [];
  for (const m of snapshot.manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(m.json[field] ?? {})) {
        checkName(name, null, m.file, findings);
        const target = aliasTarget(spec);
        if (target !== null && target !== name) checkName(target, null, m.file, findings);
      }
    }
  }
  if (snapshot.lock === null) return findings;
  for (const { name, version, aliases } of thirdPartyEntries(snapshot.lock)) {
    checkName(name, version, LOCKFILE, findings);
    for (const alias of [...aliases].sort()) if (alias !== name) checkName(alias, version, LOCKFILE, findings);
  }
  return findings;
}
