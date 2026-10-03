// Wire transactions in all three formats live on mainnet (legacy, v0 with address lookup tables, v1), and the
// lookup-table account. Layouts: solana.com/docs/core/transactions/versioned-transactions (checked 2026-10-03)
// and agave `AddressLookupTable`; golden vectors in test/chain/message.test.ts compare against the RPC's own
// parse of the same transactions.
import type { Address } from './bytes.ts';
import { DecodeError, Reader, toBase64 } from './bytes.ts';
import { encodeBase58 } from './base58.ts';

export interface MessageHeader {
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
}

export interface CompiledInstruction {
  readonly programIdIndex: number;
  readonly accounts: readonly number[];
  readonly data: Uint8Array;
}

export interface AddressTableLookup {
  readonly accountKey: Address;
  readonly writableIndexes: readonly number[];
  readonly readonlyIndexes: readonly number[];
}

/** v1 resource limits, present only when the matching mask bit is set (an unset limit is not a default). */
export interface TransactionConfig {
  /** Total priority fee in lamports (not a per-CU price). */
  readonly priorityFeeLamports?: bigint;
  readonly computeUnitLimit?: number;
  readonly loadedAccountsDataSizeLimit?: number;
  readonly requestedHeapSize?: number;
}

export type TransactionVersion = 'legacy' | 0 | 1;

export interface DecodedTransaction {
  readonly version: TransactionVersion;
  /** Base58, in account order; the first is the transaction id. */
  readonly signatures: readonly string[];
  readonly header: MessageHeader;
  /** The keys written in the message (for v0, before lookup-table keys are appended). */
  readonly staticAccountKeys: readonly Address[];
  readonly recentBlockhash: Address;
  readonly instructions: readonly CompiledInstruction[];
  /** v0 only; empty for legacy and v1. */
  readonly addressTableLookups: readonly AddressTableLookup[];
  /** v1 only. */
  readonly config?: TransactionConfig;
  /** The signed message bytes. */
  readonly message: Uint8Array;
}

const V0_PREFIX = 0x80;
const V1_PREFIX = 0x81;
const MAX_V1_COUNT = 64;

const readHeader = (r: Reader): MessageHeader => ({
  numRequiredSignatures: r.u8(),
  numReadonlySignedAccounts: r.u8(),
  numReadonlyUnsignedAccounts: r.u8(),
});

const readIndexes = (r: Reader): number[] => {
  const n = r.shortU16();
  return Array.from(r.take(n));
};

/** Legacy and v0 message body after the optional version byte. */
const readLegacyBody = (r: Reader, version: 'legacy' | 0) => {
  const header = readHeader(r);
  const nKeys = r.shortU16();
  const staticAccountKeys = Array.from({ length: nKeys }, () => r.pubkey());
  const recentBlockhash = r.pubkey();
  const nIx = r.shortU16();
  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = r.u8();
    const accounts = readIndexes(r);
    const len = r.shortU16();
    instructions.push({ programIdIndex, accounts, data: r.take(len).slice() });
  }
  const addressTableLookups: AddressTableLookup[] = [];
  if (version === 0) {
    const nLookups = r.shortU16();
    for (let i = 0; i < nLookups; i++) {
      addressTableLookups.push({ accountKey: r.pubkey(), writableIndexes: readIndexes(r), readonlyIndexes: readIndexes(r) });
    }
  }
  return { header, staticAccountKeys, recentBlockhash, instructions, addressTableLookups };
};

const CONFIG_KNOWN_BITS = 0b11111;

const readV1Config = (r: Reader, mask: number): TransactionConfig => {
  if ((mask & ~CONFIG_KNOWN_BITS) !== 0) throw new DecodeError(`v1 config mask has unknown bits: 0x${mask.toString(16)}`);
  const fee = mask & 0b11;
  if (fee === 0b01 || fee === 0b10) throw new DecodeError('v1 priority fee needs both mask bits 0 and 1');
  const config: { -readonly [K in keyof TransactionConfig]: TransactionConfig[K] } = {};
  if (fee === 0b11) config.priorityFeeLamports = r.u64();
  if (mask & 0b100) config.computeUnitLimit = r.u32();
  if (mask & 0b1000) config.loadedAccountsDataSizeLimit = r.u32();
  if (mask & 0b10000) config.requestedHeapSize = r.u32();
  return config;
};

const decodeV1 = (bytes: Uint8Array): DecodedTransaction => {
  const r = new Reader(bytes, 1);
  const header = readHeader(r);
  const mask = r.u32();
  const recentBlockhash = r.pubkey();
  const nIx = r.u8();
  const nKeys = r.u8();
  if (nIx > MAX_V1_COUNT || nKeys > MAX_V1_COUNT) throw new DecodeError(`v1 allows at most ${MAX_V1_COUNT} instructions and addresses`);
  const staticAccountKeys = Array.from({ length: nKeys }, () => r.pubkey());
  const config = readV1Config(r, mask);
  const heads = Array.from({ length: nIx }, () => ({ programIdIndex: r.u8(), numAccounts: r.u8(), dataLen: r.u16() }));
  const instructions = heads.map((h) => ({
    programIdIndex: h.programIdIndex,
    accounts: Array.from(r.take(h.numAccounts)),
    data: r.take(h.dataLen).slice(),
  }));
  const messageEnd = r.position;
  const signatures = Array.from({ length: header.numRequiredSignatures }, () => encodeBase58(r.take(64)));
  if (r.remaining !== 0) throw new DecodeError(`${r.remaining} bytes after the v1 signatures`);
  return {
    version: 1,
    signatures,
    header,
    staticAccountKeys,
    recentBlockhash,
    instructions,
    addressTableLookups: [],
    config,
    message: bytes.slice(0, messageEnd),
  };
};

/**
 * Decodes a wire transaction (as returned by `getTransaction` with `encoding: "base64"`). A v1 transaction starts
 * with 0x81 and carries its signatures at the end; legacy and v0 start with the signature count.
 */
export const decodeTransaction = (bytes: Uint8Array): DecodedTransaction => {
  if (bytes.length === 0) throw new DecodeError('empty transaction');
  if (bytes[0] === V1_PREFIX) return checkIndexes(decodeV1(bytes));
  const r = new Reader(bytes);
  const nSig = r.shortU16();
  const signatures = Array.from({ length: nSig }, () => encodeBase58(r.take(64)));
  const messageStart = r.position;
  const first = bytes[messageStart];
  if (first === undefined) throw new DecodeError('transaction has no message');
  let version: 'legacy' | 0;
  if (first & 0x80) {
    if (first !== V0_PREFIX) throw new DecodeError(`unsupported message version byte 0x${first.toString(16)}`);
    r.u8();
    version = 0;
  } else {
    version = 'legacy';
  }
  const body = readLegacyBody(r, version);
  if (r.remaining !== 0) throw new DecodeError(`${r.remaining} trailing bytes after the message`);
  if (body.header.numRequiredSignatures !== nSig) {
    throw new DecodeError(`header requires ${body.header.numRequiredSignatures} signatures, transaction has ${nSig}`);
  }
  return checkIndexes({ version, signatures, ...body, message: bytes.slice(messageStart) });
};

/** Agave's message sanitize rules (`legacy::Message::sanitize`, `v0::Message::sanitize`), applied to all formats. */
const checkIndexes = (tx: DecodedTransaction): DecodedTransaction => {
  const h = tx.header;
  const nStatic = tx.staticAccountKeys.length;
  const total = nStatic + tx.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  if (h.numRequiredSignatures === 0) throw new DecodeError('a transaction needs at least one signature (the fee payer)');
  if (h.numReadonlySignedAccounts >= h.numRequiredSignatures) throw new DecodeError('the fee payer must be writable');
  if (h.numRequiredSignatures + h.numReadonlyUnsignedAccounts > nStatic) throw new DecodeError('header counts exceed the static account keys');
  if (total > 256) throw new DecodeError(`${total} account keys; at most 256 are addressable`);
  for (const l of tx.addressTableLookups) {
    if (l.writableIndexes.length + l.readonlyIndexes.length === 0) throw new DecodeError(`lookup of ${l.accountKey} loads no accounts`);
  }
  for (const ix of tx.instructions) {
    if (ix.programIdIndex === 0) throw new DecodeError('the fee payer cannot be a program');
    if (ix.programIdIndex >= nStatic) throw new DecodeError(`program index ${ix.programIdIndex} is not a static key`);
    for (const a of ix.accounts) if (a >= total) throw new DecodeError(`account index ${a} is out of range (${total} keys)`);
  }
  return tx;
};

/** Address lookup table account (program AddressLookupTab1e1111111111111111111111111). */
export interface LookupTable {
  /** u64::MAX while active. */
  readonly deactivationSlot: bigint;
  readonly lastExtendedSlot: bigint;
  readonly lastExtendedSlotStartIndex: number;
  /** Null once frozen. */
  readonly authority: Address | null;
  readonly addresses: readonly Address[];
}

const LOOKUP_TABLE_META_SIZE = 56;
export const U64_MAX = BigInt.asUintN(64, -1n);

export const decodeLookupTable = (data: Uint8Array): LookupTable => {
  if (data.length < LOOKUP_TABLE_META_SIZE) throw new DecodeError('lookup table shorter than its 56-byte header');
  const r = new Reader(data);
  const state = r.u32();
  if (state !== 1) throw new DecodeError(`lookup table state must be 1 (LookupTable), got ${state}`);
  const deactivationSlot = r.u64();
  const lastExtendedSlot = r.u64();
  const lastExtendedSlotStartIndex = r.u8();
  const tag = r.u8();
  if (tag > 1) throw new DecodeError(`invalid Option tag ${tag}`);
  const authority = tag === 1 ? r.pubkey() : null;
  if ((data.length - LOOKUP_TABLE_META_SIZE) % 32 !== 0) throw new DecodeError('lookup table address area is not a multiple of 32 bytes');
  const body = new Reader(data, LOOKUP_TABLE_META_SIZE);
  const addresses = Array.from({ length: body.remaining / 32 }, () => body.pubkey());
  return { deactivationSlot, lastExtendedSlot, lastExtendedSlotStartIndex, authority, addresses };
};

export interface LoadedAddresses {
  readonly writable: readonly Address[];
  readonly readonly: readonly Address[];
}

/**
 * Resolves v0 lookups against table accounts read at `slot`: all writable lookups in order, then all read-only
 * ones. Addresses appended in `slot` itself are not usable yet (agave `get_active_addresses_len`). A deactivated
 * table is refused, since whether it is still usable needs the slot-hashes sysvar.
 */
export const resolveLookups = (
  lookups: readonly AddressTableLookup[],
  tables: ReadonlyMap<string, LookupTable>,
  slot: bigint,
): LoadedAddresses => {
  const pick = (l: AddressTableLookup, indexes: readonly number[]) => {
    const t = tables.get(l.accountKey);
    if (!t) throw new DecodeError(`lookup table ${l.accountKey} not provided`);
    if (t.deactivationSlot !== U64_MAX) throw new DecodeError(`lookup table ${l.accountKey} is deactivated`);
    const active = slot > t.lastExtendedSlot ? t.addresses.length : t.lastExtendedSlotStartIndex;
    return indexes.map((i) => {
      if (i >= active) throw new DecodeError(`lookup index ${i} beyond the ${active} active addresses of ${l.accountKey}`);
      return t.addresses[i]!;
    });
  };
  return {
    writable: lookups.flatMap((l) => pick(l, l.writableIndexes)),
    readonly: lookups.flatMap((l) => pick(l, l.readonlyIndexes)),
  };
};

/**
 * Every account key in instruction-index order: static keys, then loaded writable, then loaded read-only. The loaded
 * lists must have exactly as many keys as the lookups ask for (a stored record that disagrees is corrupt), and a
 * transaction without lookups takes none. A key that appears twice is refused, as the runtime refuses it.
 */
export const accountKeys = (tx: DecodedTransaction, loaded?: LoadedAddresses): Address[] => {
  const w = tx.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length, 0);
  const ro = tx.addressTableLookups.reduce((n, l) => n + l.readonlyIndexes.length, 0);
  const lw = loaded?.writable.length ?? 0;
  const lr = loaded?.readonly.length ?? 0;
  if (lw !== w || lr !== ro) {
    throw new DecodeError(`lookups ask for ${w} writable and ${ro} read-only keys; ${lw} and ${lr} were given`);
  }
  const keys = [...tx.staticAccountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  // The runtime refuses a transaction that names any account twice, static or loaded (AccountLoadedTwice).
  if (new Set(keys).size !== keys.length) throw new DecodeError('an account key appears more than once');
  return keys;
};

/** Whether the key at `index` is writable, per the header rules (and lookup position for loaded keys). */
export const isWritable = (tx: DecodedTransaction, index: number, loaded?: LoadedAddresses): boolean => {
  const keys = accountKeys(tx, loaded);
  if (!Number.isInteger(index) || index < 0 || index >= keys.length) throw new RangeError(`account index ${index} is out of range (${keys.length} keys)`);
  const h = tx.header;
  const nStatic = tx.staticAccountKeys.length;
  if (index < h.numRequiredSignatures) return index < h.numRequiredSignatures - h.numReadonlySignedAccounts;
  if (index < nStatic) return index < nStatic - h.numReadonlyUnsignedAccounts;
  const w = loaded?.writable.length ?? 0;
  return index < nStatic + w;
};

export const isSigner = (tx: DecodedTransaction, index: number): boolean => {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`account index ${index} is out of range`);
  return index < tx.header.numRequiredSignatures;
};

/** Base64 of instruction data, for logs and JSON. */
export const instructionDataBase64 = (ix: CompiledInstruction): string => toBase64(ix.data);
