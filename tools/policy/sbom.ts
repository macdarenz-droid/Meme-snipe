// SBOM per release (B-M30-01 logic 5; ARCH 12.3). pnpm 10.28.0 has no SBOM command (`pnpm sbom` answers "Command not
// found"; the pnpm docs give it as added in v11.0.0); C01 ran `npm sbom --sbom-format=cyclonedx --omit=dev`. This
// writes the same kind of document from the lockfile: a CycloneDX 1.6 JSON BOM (CycloneDX bom-1.6.schema.json:
// `bomFormat` "CycloneDX" and `specVersion` required; a component needs `type` and `name`; a hash is `alg` "SHA-512"
// with hex `content`; a licence is one SPDX `expression`) of the production closure of the checked workspace projects
// (development dependencies omitted, as C01 did). Each component carries its npm package URL (purl-spec
// types/npm-definition.json: pkg:npm/foobar@12.3.1, pkg:npm/%40angular/animation@12.3.1), the sha512 of its lockfile
// integrity, and the licence its installed package.json declares (omitted when it declares none or is not installed
// here). No serial number and no timestamp (both optional): the same commit gives the same bytes.
import { checkedImporters } from './allowlist.ts';
import { finding, formatFindings, type Io } from './finding.ts';
import { installedPackages, VIRTUAL_STORE } from './installed.ts';
import { closure, IMPORTER_PRODUCTION_FIELDS, splitId, type PnpmLock } from './lockfile.ts';
import { readRepo, type RepoSnapshot } from './repo.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scopeOf } from './scope.ts';

export interface SbomComponent {
  type: 'library'; name: string; version: string; purl: string;
  hashes: Array<{ alg: 'SHA-512'; content: string }>; licenses?: Array<{ expression: string }>;
}

/** The npm purl of `name@version`: the scope's "@" percent-encoded, as the purl spec requires. */
export function npmPurl(name: string, version: string): string {
  return `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
}

/** The hex digest of an `sha512-<base64>` integrity, or null when it is not one. */
export function sha512Hex(integrity: string | undefined): string | null {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity ?? '');
  if (m === null) return null;
  const hex = Buffer.from(m[1] as string, 'base64').toString('hex');
  return hex.length === 128 ? hex : null;
}

/** The CycloneDX document for the production closure of the checked importers. Throws on an entry with no sha512. */
export function buildSbom(snapshot: RepoSnapshot, lock: PnpmLock, licences: ReadonlyMap<string, string>): Record<string, unknown> {
  const keys = [...closure(lock, checkedImporters(snapshot, scopeOf(false)), IMPORTER_PRODUCTION_FIELDS).packages].sort();
  const components: SbomComponent[] = keys.map((key) => {
    const [name, version] = splitId(key) ?? [key, ''];
    const hex = sha512Hex(lock.packages[key]?.resolution['integrity']);
    if (hex === null) throw new Error(`${key} has no sha512 integrity in the lockfile`);
    const licence = licences.get(key);
    return {
      type: 'library', name, version, purl: npmPurl(name, version), hashes: [{ alg: 'SHA-512', content: hex }],
      ...(licence === undefined ? {} : { licenses: [{ expression: licence }] }),
    };
  });
  const root = snapshot.manifests.find((m) => m.dir === '')?.json;
  return {
    bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    metadata: { component: { type: 'application', name: root?.name ?? 'root', ...(root?.version === undefined ? {} : { version: root.version }) } },
    components,
  };
}

/** Usage: sbom.ts [root] > sbom.cdx.json. Exit 0 with the document on stdout, 1 when it cannot be built. */
export function main(argv: readonly string[], io: Io): number {
  const root = argv[0] ?? process.cwd();
  const { snapshot, findings } = readRepo(root);
  if (findings.length > 0 || snapshot.lock === null) {
    io.err(formatFindings(findings.length > 0 ? findings : [finding('E_LOCK_MISSING', 'pnpm-lock.yaml', 'the committed lockfile is missing')]));
    return 1;
  }
  const licences = new Map<string, string>();
  if (existsSync(join(root, VIRTUAL_STORE))) {
    for (const p of installedPackages(root)) if (p.name !== null && p.version !== null && p.license !== null) licences.set(`${p.name}@${p.version}`, p.license);
  }
  try {
    io.out(JSON.stringify(buildSbom(snapshot, snapshot.lock, licences), null, 2));
  } catch (e) {
    io.err(formatFindings([finding('E_SBOM', 'pnpm-lock.yaml', (e as Error).message)]));
    return 1;
  }
  return 0;
}
