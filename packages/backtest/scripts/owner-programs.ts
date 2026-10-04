// Builds the owner-program supplement (src/dataset/owner-programs.ts) for schema-3 datasets: every off-curve owner
// seen in their trade and movement rows and every off-curve pool creator, looked up once with getMultipleAccounts.
//
//   node packages/backtest/scripts/owner-programs.ts owners --dataset <dir> [--dataset <dir> ...]
//       prints the datasets' off-curve owners, one per line, sorted and unique (SHA256SUMS checked when present)
//   node packages/backtest/scripts/owner-programs.ts fetch --owners <file> --out <dir> [--datasets <json>] [--dry-run]
//       looks the owners up and writes the supplement; --dry-run writes only the plan (owners, calls) and reads no RPC
//   node packages/backtest/scripts/owner-programs.ts --dataset <dir> --out <dir>
//       both in one go (BT-1d)
//
// RPC: RPC_URL (RPC_NAME names it in the manifest), or HELIUS_API_KEY for Helius mainnet. The URL and the key are
// never written to a file or printed, errors included. Cost: one call per 100 owners, recorded in the manifest.
// The owners workflow (.github/workflows/owner-programs.yml) runs `owners` per dataset release and `fetch` once.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pumpPoolAuthority, type Address } from '../../core/src/chain/index.ts';
import { offCurve } from '../../core/src/gates/index.ts';
import { loadDay, loadManifest, loadMovements, manifestHash, verifySums } from '../src/dataset/dataset.ts';
import { ACCOUNTS_PER_CALL, fetchOwnerPrograms, writeOwnerPrograms, type DatasetSource } from '../src/dataset/owner-programs.ts';

const OWNER_PROGRAMS_PLAN = 'owner-programs.plan.json';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const args = process.argv.slice(2);
const cmd = args[0] === 'owners' || args[0] === 'fetch' ? args.shift()! : 'all';
const all = (n: string): string[] => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] !== undefined ? [args[i + 1]!] : []));
const flag = (n: string): string => {
  const v = all(n)[0];
  if (v === undefined) throw new Error(`--${n} is required`);
  return v;
};

// Everything printed or thrown passes through here: the RPC URL and the key never leave the process. A provider can
// echo just the key, so every part of RPC_URL that can carry one (query values, user info, long path segments such as
// Alchemy's /v2/<key>) is scrubbed on its own too.
const urlParts = (u: string | undefined): string[] => {
  if (u === undefined) return [];
  try {
    const p = new URL(u);
    return [...p.searchParams.values(), p.username, p.password, ...p.pathname.split('/').filter((x) => x.length >= 16), p.search, p.pathname];
  } catch {
    return [];
  }
};
const secrets = [process.env['RPC_URL'], process.env['HELIUS_API_KEY'], ...urlParts(process.env['RPC_URL'])]
  .filter((s): s is string => s !== undefined && s.length >= 4 && s !== '/')
  .sort((a, b) => b.length - a.length);
const scrub = (s: string): string => secrets.reduce((t, x) => t.split(x).join('[redacted]'), s);

/**
 * Off-curve owners of one dataset's rows: trade and movement owners, and the creator of a CreatePoolEvent, which the
 * holder book credits with the base it pays in (src/dataset/holders.ts), except pump's own pool authority on a migration.
 */
const ownersOf = (dataset: string): Set<string> => {
  verifySums(dataset);
  const manifest = loadManifest(dataset);
  const owners = new Set<string>();
  for (const day of manifest.days) {
    for (const r of loadDay(dataset, day)) {
      if ((r.kind === 'amm' || r.kind === 'curve') && r.userTokenOwner !== '' && offCurve(r.userTokenOwner)) owners.add(r.userTokenOwner);
      if (r.kind === 'event' && r.event === 'CreatePoolEvent') {
        const creator = r.fields['creator'] ?? '';
        const mint = r.fields['mint'] ?? r.fields['base_mint'];
        if (creator !== '' && mint !== undefined && offCurve(creator) && creator !== pumpPoolAuthority(mint as Address)) owners.add(creator);
      }
    }
    for (const m of loadMovements(dataset, day)) for (const o of [m.fromOwner, m.toOwner]) if (o !== '' && offCurve(o)) owners.add(o);
  }
  return owners;
};

const rpcTarget = (): { url: string; name: string } => {
  const url = process.env['RPC_URL'];
  if (url !== undefined && url !== '') return { url, name: process.env['RPC_NAME'] ?? 'unnamed provider' };
  const key = process.env['HELIUS_API_KEY'];
  if (key !== undefined && key !== '') return { url: `https://mainnet.helius-rpc.com/?api-key=${key}`, name: 'helius' };
  throw new Error('RPC_URL or HELIUS_API_KEY is required (or --dry-run)');
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One getMultipleAccounts call: the owning program of each address, null when absent. Retries 429 and 5xx. */
const getOwners = (url: string) => async (addresses: readonly string[]): Promise<(string | null)[]> => {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [addresses, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] }),
      });
    } catch (e) {
      // The cause of a failed fetch can carry the request URL: only its name is kept.
      throw new Error(`getMultipleAccounts: request failed (${e instanceof Error ? e.name : 'error'})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    if (!res.ok) throw new Error(`getMultipleAccounts: HTTP ${res.status}`);
    let j: { result?: { value?: unknown }; error?: unknown };
    try {
      j = (await res.json()) as typeof j;
    } catch {
      throw new Error('getMultipleAccounts: the reply is not JSON');
    }
    if (j.result === undefined) throw new Error(`getMultipleAccounts failed: ${JSON.stringify(j.error) ?? 'no result'}`);
    const value = j.result.value;
    if (!Array.isArray(value) || value.length !== addresses.length) throw new Error('getMultipleAccounts: the reply does not list one account per address');
    return value.map((v: unknown) => {
      if (v === null) return null;
      const owner = (v as { owner?: unknown }).owner;
      if (typeof owner !== 'string' || !BASE58.test(owner)) throw new Error('getMultipleAccounts: an account has no valid owner');
      return owner;
    });
  }
};

const readOwners = (file: string): string[] => {
  const owners = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
  for (const o of owners) if (!BASE58.test(o) || !offCurve(o)) throw new Error(`--owners lists ${o.slice(0, 12)}…, which is not an off-curve address`);
  return [...new Set(owners)].sort();
};

const readSources = (file: string | undefined): DatasetSource[] => {
  if (file === undefined) return [];
  const list = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(list) || !list.every((d) => typeof d?.tag === 'string' && /^[0-9a-f]{64}$/.test(String(d?.manifestSha256)))) throw new Error('--datasets must be a JSON list of {tag, manifestSha256}');
  return list as DatasetSource[];
};

const fetchAndWrite = async (owners: string[], out: string, datasets: DatasetSource[], dryRun: boolean): Promise<unknown> => {
  if (dryRun) {
    const plan = { owners: owners.length, calls: Math.ceil(owners.length / ACCOUNTS_PER_CALL), accountsPerCall: ACCOUNTS_PER_CALL, datasets };
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, OWNER_PROGRAMS_PLAN), `${JSON.stringify(plan, null, 1)}\n`);
    return { dryRun: true, ...plan };
  }
  const target = rpcTarget();
  const { rows, calls } = await fetchOwnerPrograms(owners, getOwners(target.url));
  return writeOwnerPrograms(out, rows, { calls, source: target.name, fetchedAt: new Date().toISOString(), datasets });
};

try {
  if (cmd === 'owners') {
    const datasets = all('dataset');
    if (datasets.length === 0) throw new Error('--dataset is required');
    const owners = new Set<string>();
    for (const d of datasets) for (const o of ownersOf(d)) owners.add(o);
    process.stdout.write([...owners].sort().map((o) => `${o}\n`).join(''));
  } else if (cmd === 'fetch') {
    const m = await fetchAndWrite(readOwners(flag('owners')), flag('out'), readSources(all('datasets')[0]), args.includes('--dry-run'));
    console.log(JSON.stringify(m));
  } else {
    const dataset = flag('dataset');
    const m = await fetchAndWrite([...ownersOf(dataset)].sort(), flag('out'), [{ tag: dataset, manifestSha256: manifestHash(dataset) }], args.includes('--dry-run'));
    console.log(JSON.stringify(m));
  }
} catch (e) {
  console.error(`owner-programs: ${scrub(e instanceof Error ? e.message : String(e))}`);
  process.exit(1);
}
