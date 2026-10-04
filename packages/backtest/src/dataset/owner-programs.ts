// The owner-program supplement for holder facts (BT-1d R2, supervisor ruling): the program that owns each off-curve
// (PDA) holder owner, fetched once with getMultipleAccounts and kept as JSON lines with a manifest of its sha256, row
// count and cost (the RUG-1c / insider-supplement pattern). Backtests read it instead of calling RPC, so reruns are
// deterministic and free. As-of risk: a PDA's owning program is fixed when the account is created and practically never
// changes, so a later read stands for the decision time; an owner missing from the supplement leaves its mint
// unresolved.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OwnerProgramRow {
  readonly owner: string;
  /** The owner account's program, or null when that account does not exist on chain. */
  readonly program: string | null;
}

/** A dataset the owners were read from: its release tag (or directory) and the sha256 of its manifest.json. */
export interface DatasetSource {
  readonly tag: string;
  readonly manifestSha256: string;
}

export interface OwnerProgramManifest {
  readonly file: string;
  readonly sha256: string;
  readonly rows: number;
  /** getMultipleAccounts calls the fetch made, and the accounts it asked for. */
  readonly calls: number;
  readonly accounts: number;
  /** Where it was read (provider name, never a key) and when (ISO). */
  readonly source: string;
  readonly fetchedAt: string;
  /** The datasets whose owners it covers (BT-1e). Absent in supplements written before it. */
  readonly datasets?: readonly DatasetSource[];
}

export const OWNER_PROGRAMS_FILE = 'owner-programs.jsonl';
export const OWNER_PROGRAMS_MANIFEST = 'owner-programs.manifest.json';
/** getMultipleAccounts takes at most 100 accounts per call. */
export const ACCOUNTS_PER_CALL = 100;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Writes rows sorted by owner (the same bytes for the same rows) and the manifest. */
export const writeOwnerPrograms = (
  dir: string,
  rows: readonly OwnerProgramRow[],
  cost: { readonly calls: number; readonly source: string; readonly fetchedAt: string; readonly datasets?: readonly DatasetSource[] },
): OwnerProgramManifest => {
  mkdirSync(dir, { recursive: true });
  const sorted = [...rows].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  const body = sorted.map((r) => JSON.stringify({ owner: r.owner, program: r.program })).join('\n') + (rows.length > 0 ? '\n' : '');
  const m: OwnerProgramManifest = {
    file: OWNER_PROGRAMS_FILE, sha256: sha256(body), rows: rows.length, calls: cost.calls, accounts: rows.length, source: cost.source, fetchedAt: cost.fetchedAt,
    ...(cost.datasets === undefined ? {} : { datasets: cost.datasets }),
  };
  writeFileSync(join(dir, OWNER_PROGRAMS_FILE), body);
  writeFileSync(join(dir, OWNER_PROGRAMS_MANIFEST), `${JSON.stringify(m, null, 1)}\n`);
  return m;
};

/** Reads the supplement, refusing it when its hash, row count or any row does not check out. */
export const readOwnerPrograms = (dir: string): ReadonlyMap<string, string | null> => {
  const m = JSON.parse(readFileSync(join(dir, OWNER_PROGRAMS_MANIFEST), 'utf8')) as OwnerProgramManifest;
  const body = readFileSync(join(dir, m.file), 'utf8');
  if (sha256(body) !== m.sha256) throw new Error('owner-program supplement: sha256 does not match the manifest');
  const rows = body.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as OwnerProgramRow);
  if (rows.length !== m.rows) throw new Error('owner-program supplement: row count does not match the manifest');
  const out = new Map<string, string | null>();
  for (const r of rows) {
    if (typeof r.owner !== 'string' || r.owner === '' || (r.program !== null && typeof r.program !== 'string') || out.has(r.owner)) throw new Error(`owner-program supplement: row ${String(r.owner)} is malformed`);
    out.set(r.owner, r.program);
  }
  return out;
};

/** The owning program of each address, null when the account does not exist (one getMultipleAccounts call). */
export type GetMultipleOwners = (addresses: readonly string[]) => Promise<readonly (string | null)[]>;

/** Looks up every owner once, in calls of at most 100 accounts. */
export const fetchOwnerPrograms = async (owners: readonly string[], get: GetMultipleOwners): Promise<{ readonly rows: OwnerProgramRow[]; readonly calls: number }> => {
  const unique = [...new Set(owners)].sort();
  const rows: OwnerProgramRow[] = [];
  let calls = 0;
  for (let k = 0; k < unique.length; k += ACCOUNTS_PER_CALL) {
    const batch = unique.slice(k, k + ACCOUNTS_PER_CALL);
    const got = await get(batch);
    calls++;
    if (got.length !== batch.length) throw new Error(`getMultipleAccounts returned ${got.length} accounts for ${batch.length}`);
    batch.forEach((owner, i) => rows.push({ owner, program: got[i] ?? null }));
  }
  return { rows, calls };
};
