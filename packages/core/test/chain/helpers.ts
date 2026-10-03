// Test oracles for the chain decoders. `idlDecode` is a second, independent decoder that interprets the pinned
// IDL JSON at run time with its own byte reader (Node Buffer, no code shared with src/chain); the hand-written
// decoders must agree with it on every real account and event.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const readFixture = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as T;

export type IdlType = string | { array: [IdlType, number] } | { vec: IdlType } | { defined: { name: string } };
export interface IdlStruct {
  kind: 'struct';
  fields: { name: string; type: IdlType }[];
}
export interface PinnedProgram {
  address: string;
  sha256: string;
  accounts: Record<string, number[]>;
  events: Record<string, number[]>;
  types: Record<string, IdlStruct>;
}
export interface PinnedIdl {
  commit: string;
  programs: Record<'pump' | 'pump_amm' | 'pump_fees', PinnedProgram>;
}

export const IDL = readFixture<PinnedIdl>('idl-pinned.json');

export const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 by repeated bigint division: a different algorithm from src/chain/base58.ts. */
const base58 = (b: Buffer): string => {
  let n = BigInt('0x' + (b.toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = '1' + out;
  }
  return out;
};

/** The oracle's own little-endian reader over a Node Buffer. */
class OracleReader {
  private o = 0;
  private readonly b: Buffer;
  constructor(bytes: Uint8Array) {
    this.b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining() {
    return this.b.length - this.o;
  }
  private take(n: number) {
    if (this.o + n > this.b.length) throw new RangeError('oracle: read past end');
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  u8 = () => this.take(1).readUInt8(0);
  u16 = () => this.take(2).readUInt16LE(0);
  u32 = () => this.take(4).readUInt32LE(0);
  u64 = () => this.take(8).readBigUInt64LE(0);
  i64 = () => this.take(8).readBigInt64LE(0);
  u128 = () => {
    const s = this.take(16);
    return s.readBigUInt64LE(0) + (s.readBigUInt64LE(8) << 64n);
  };
  i128 = () => {
    const s = this.take(16);
    return s.readBigUInt64LE(0) + (s.readBigInt64LE(8) << 64n);
  };
  bool = () => {
    const v = this.u8();
    if (v > 1) throw new RangeError('oracle: bool byte above 1');
    return v === 1;
  };
  pubkey = () => base58(this.take(32));
  string = () => this.take(this.u32()).toString('utf8');
}

const readType = (t: IdlType, r: OracleReader, types: Record<string, IdlStruct>): unknown => {
  if (typeof t === 'string') {
    switch (t) {
      case 'u8':
        return r.u8();
      case 'u16':
        return r.u16();
      case 'u32':
        return r.u32();
      case 'u64':
        return r.u64();
      case 'i64':
        return r.i64();
      case 'u128':
        return r.u128();
      case 'i128':
        return r.i128();
      case 'bool':
        return r.bool();
      case 'pubkey':
        return r.pubkey();
      case 'string':
        return r.string();
      default:
        throw new Error(`oracle: unsupported IDL type ${t}`);
    }
  }
  if ('array' in t) return Array.from({ length: t.array[1] }, () => readType(t.array[0], r, types));
  if ('vec' in t) {
    const n = r.u32();
    return Array.from({ length: n }, () => readType(t.vec, r, types));
  }
  const def = types[t.defined.name];
  if (!def) throw new Error(`oracle: type ${t.defined.name} not pinned`);
  return readStruct(def, r, types, false);
};

const readStruct = (def: IdlStruct, r: OracleReader, types: Record<string, IdlStruct>, prefixAllowed: boolean) => {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (prefixAllowed && r.remaining === 0) break;
    out[camel(f.name)] = readType(f.type, r, types);
  }
  return out;
};

/** Decodes `bytes` (after any discriminator) as IDL type `name`; an older, shorter layout yields a prefix. */
export const idlDecode = (program: keyof PinnedIdl['programs'], name: string, bytes: Uint8Array) => {
  const p = IDL.programs[program];
  const def = p.types[name];
  if (!def) throw new Error(`oracle: ${name} not pinned for ${program}`);
  const r = new OracleReader(bytes);
  const value = readStruct(def, r, p.types, true);
  return { value, trailing: r.remaining };
};

/** bigint and number both become decimal strings, so Bps numbers and IDL u64 bigints compare equal. */
export const normalize = (v: unknown): unknown => {
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
};

export interface AccountFixture {
  label: string;
  address: string;
  slot: number;
  owner: string;
  lamports: number;
  dataBase64: string;
  parsed?: { parsed: { type: string; info: Record<string, unknown> }; program: string; space: number };
}

export interface TxFixture {
  label: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  version: 'legacy' | 0 | 1;
  base64: {
    slot: number;
    blockTime: number | null;
    transaction: [string, string];
    meta: {
      err: unknown;
      loadedAddresses: { writable: string[]; readonly: string[] } | null;
      innerInstructions: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string; stackHeight: number | null }[] }[] | null;
      logMessages: string[] | null;
      preTokenBalances: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null;
      postTokenBalances: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null;
    };
  };
  jsonMessage: {
    accountKeys: string[];
    header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
    recentBlockhash: string;
    instructions: { programIdIndex: number; accounts: number[]; data: string; stackHeight?: number | null }[];
    addressTableLookups?: { accountKey: string; writableIndexes: number[]; readonlyIndexes: number[] }[];
    transactionConfig?: Record<string, unknown>;
  };
}

export const ACCOUNTS = readFixture<{ accounts: AccountFixture[] }>('accounts.json').accounts;
export const TRANSACTIONS = readFixture<{ transactions: TxFixture[] }>('transactions.json').transactions;

export const account = (label: string): AccountFixture => {
  const a = ACCOUNTS.find((x) => x.label === label);
  if (!a) throw new Error(`fixture account "${label}" missing`);
  return a;
};
export const accountsLabelled = (prefix: string): AccountFixture[] => ACCOUNTS.filter((x) => x.label.startsWith(prefix));
