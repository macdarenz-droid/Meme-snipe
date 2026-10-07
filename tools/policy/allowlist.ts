// DEPENDENCIES.md allowlist (B-M30-01 logic 3): every third-party package the lockfile installs for a checked
// workspace project (every importer the Zeroed manifest does not know) is listed by exact name with purpose, licence and
// a named reviewer. An alias install (`"x": "npm:y@1.0.0"`) needs rows for both the real package and the alias name.
// pnpm-lock.yaml v9 records no licence, so the licence cell is compared with each installed package's own
// package.json by the installed-package scan (installed.ts), which CI runs right after the install.
import { finding, type Finding } from './finding.ts';
import { closure, IMPORTER_FIELDS, splitId } from './lockfile.ts';
import type { RepoSnapshot } from './repo.ts';
import { scopeOf, type Scope } from './scope.ts';

const FILE = 'DEPENDENCIES.md';
export const ALLOWLIST_HEADER = ['Package', 'Purpose', 'Licence', 'Reviewer'];
export const AGE_EXCEPTION_HEADER = ['Package', 'Reason', 'Reviewer'];
/** Licence cell for a package whose lockfile entry declares none. */
export const NO_LICENCE = 'none declared';

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** A reviewer cell that names nobody: empty, "pending" (the freeze sign-off check refuses it too) or a dash. */
export function isUnnamedReviewer(cell: string): boolean {
  return cell === '' || /^pending\b/i.test(cell) || /^[-—–?]+$/.test(cell);
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x.toLowerCase() === (b[i] as string).toLowerCase());

/** Rows of the markdown table whose header row is `header`; null when no such table exists. */
export function parseTable(md: string, header: readonly string[]): Array<{ cells: string[]; line: number }> | null {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('|') && same(cells(l), header));
  if (start < 0) return null;
  const rows: Array<{ cells: string[]; line: number }> = [];
  for (let i = start + 2; i < lines.length && (lines[i] as string).trim().startsWith('|'); i++) {
    rows.push({ cells: cells(lines[i] as string).map((c) => c.replace(/^`(.*)`$/, '$1')), line: i + 1 });
  }
  return rows;
}

export function checkAllowlist(snapshot: RepoSnapshot, scope: Scope = scopeOf(false)): Finding[] {
  if (snapshot.dependenciesMd === null) return [finding('E_DEPENDENCIES_MD', FILE, 'DEPENDENCIES.md is missing')];
  const rows = parseTable(snapshot.dependenciesMd, ALLOWLIST_HEADER);
  if (rows === null) return [finding('E_DEPENDENCIES_MD', FILE, `no table with the header | ${ALLOWLIST_HEADER.join(' | ')} |`)];
  const findings: Finding[] = [];
  const licences = new Map<string, string>();
  const unnamed: number[] = [];
  for (const { cells: [name = '', purpose = '', licence = '', reviewer = ''], line } of rows) {
    if (name === '' || purpose === '' || licence === '') {
      findings.push(finding('E_ALLOWLIST_ROW', `${FILE}:${line}`, 'every row needs a package, purpose, licence and reviewer'));
    } else if (licences.has(name)) {
      findings.push(finding('E_ALLOWLIST_ROW', `${FILE}:${line}`, `${name} is listed twice`));
    } else {
      licences.set(name, licence);
      if (isUnnamedReviewer(reviewer)) unnamed.push(line);
    }
  }
  if (unnamed.length > 0) {
    findings.push(finding('E_ALLOWLIST_REVIEWER', FILE, `${unnamed.length} row(s) name no reviewer ("pending" or empty), first at line ${unnamed[0] as number}; the reviewer who read the dependency diff signs each row`));
  }
  for (const [key, names] of allowlistScope(snapshot, scope)) {
    for (const n of [...names].sort()) {
      if (!licences.has(n)) findings.push(finding('E_NOT_ALLOWLISTED', FILE, `${n} (${key}) is not in the allowlist`));
    }
  }
  return findings;
}

/** Licence cells of the allowlist by package name (rows that name a package and a licence). */
export function allowlistLicences(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { cells: [name = '', , licence = ''] } of parseTable(md, ALLOWLIST_HEADER) ?? []) if (name !== '' && licence !== '') out.set(name, licence);
  return out;
}

/** Workspace importers in scope: the root and every package directory the scope admits. */
export function checkedImporters(snapshot: RepoSnapshot, scope: Scope): string[] {
  return Object.keys(snapshot.lock?.importers ?? {}).filter((dir) => dir === '.' || scope(`${dir}/`)).sort();
}

/** `name@version` → every name it is installed under, for the packages the importers in scope reach (all fields). */
export function allowlistScope(snapshot: RepoSnapshot, scope: Scope): Map<string, Set<string>> {
  if (snapshot.lock === null) return new Map();
  const c = closure(snapshot.lock, checkedImporters(snapshot, scope), IMPORTER_FIELDS);
  const out = new Map<string, Set<string>>();
  for (const key of [...c.packages].sort()) out.set(key, c.names.get(key) ?? new Set([splitId(key)?.[0] ?? key]));
  return out;
}
