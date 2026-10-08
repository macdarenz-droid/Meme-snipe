// Valid sample rows for every table, built from the descriptors (test helper for B-M24-02).
import type { ColumnDef } from '../../src/m24/schema.ts';
import { TABLES, type TableName } from '../../src/m24/schema.ts';
import type { RowOf } from '../../src/m24/repos.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function digits(n: number, alphabet: string, length: number): string {
  let out = '';
  let v = n;
  for (let i = 0; i < length; i++) {
    out = (alphabet[v % alphabet.length] as string) + out;
    v = Math.floor(v / alphabet.length);
  }
  return out;
}

export const ulid = (n: number): string => `01J${digits(n, CROCKFORD, 23)}`;
export const pubkey = (n: number): string => `So1${digits(n, BASE58, 41)}`;
export const signature = (n: number): string => `5ig${digits(n, BASE58, 85)}`;
export const sha256 = (n: number): string => n.toString(16).padStart(64, '0');

/** A valid value of a column kind, varied by `n`. */
export function sampleValue(def: ColumnDef, n: number): unknown {
  switch (def.kind) {
    case 'ulid': return ulid(n);
    case 'pubkey': return pubkey(n);
    case 'signature': return signature(n);
    case 'sha256': return sha256(n);
    case 'json': return `{"n":${n}}`;
    case 'bool': return n % 2 === 0;
    case 'int': return n;
    case 'ms': return 1_759_000_000_000 + n;
    case 'real': return n + 0.5;
    case 'lamports': return 5_000n + BigInt(n);
    case 'slamports': return -5_000n - BigInt(n);
    case 'i64': return 9_000_000_000_000_000_000n + BigInt(n);
    case 'u64': return n === 0 ? '18446744073709551615' : String(n);
    case 'i128': return `-${n + 1}`;
    case 'decimal': return `0.${String(n + 1).padStart(6, '0')}`;
    case 'enum': return (def.values as readonly string[])[n % (def.values as readonly string[]).length];
    case 'blob': return new Uint8Array([n % 256, 1, 2]);
    default: return def.maxBytes === undefined ? `text-${n}` : `t${n}`.slice(0, def.maxBytes);
  }
}

/** A valid row of `table`; `nulls` sets every nullable column to null. */
export function sampleRow<N extends TableName>(table: N, n: number, nulls = false): RowOf<N> {
  const row: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(TABLES[table].columns) as Array<[string, ColumnDef]>) {
    row[name] = nulls && def.nullable === true ? null : sampleValue(def, n);
  }
  if (table === 'system_state') row.id = 1;
  if (table === 'trade') {
    const costs = ['costNetworkBaseLamports', 'costPriorityLamports', 'costTipsLamports', 'costVenueFeesLamports', 'costFailedTxLamports']
      .reduce((sum, k) => sum + (row[k] as bigint), 0n);
    row.totalCostsLamports = costs;
    row.netPnlLamports = (row.grossPnlLamports as bigint) - costs;
  }
  if (table === 'wallet_snapshot' && !nulls) row.granularity = 'daily';
  return row as RowOf<N>;
}
