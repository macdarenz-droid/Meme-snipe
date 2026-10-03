// Compiles instructions into a v0 message with address lookup tables, and serializes the unsigned wire transaction
// (zeroed signature slots, the form `simulateTransaction` with `sigVerify: false` accepts and the signer fills in).
// Layout: solana.com/docs/core/transactions/versioned-transactions; the DEC-1 decoder reads every byte back in the
// tests and must reproduce each account, program and amount.
import type { Address } from '../chain/index.ts';
import type { Instruction } from './instruction.ts';
import { Writer } from './instruction.ts';

/** A lookup table as read at a known slot: only the addresses already active there (chain `resolveLookups` rules). */
export interface LookupTableInput {
  readonly address: Address;
  readonly addresses: readonly Address[];
}

export interface CompiledMessage {
  /** The serialized v0 message: the bytes that get signed. */
  readonly message: Uint8Array;
  /** Unsigned wire transaction: signature count, zeroed signatures, message. */
  readonly wire: Uint8Array;
  readonly staticKeys: readonly Address[];
  readonly lookups: readonly { readonly table: Address; readonly writable: readonly number[]; readonly readonly: readonly number[] }[];
}

/** Packet data limit for legacy and v0 transactions (`PACKET_DATA_SIZE`). */
export const MAX_TRANSACTION_BYTES = 1232;
const V0_PREFIX = 0x80;
const SIGNATURE_BYTES = 64;
const MAX_INDEXABLE = 256;

interface KeyFlags {
  signer: boolean;
  writable: boolean;
  invoked: boolean;
}

/**
 * `lookupAllowed` names the keys that may be loaded from a table. Signers and invoked programs are never loaded
 * (the runtime refuses both), and anything the caller does not allow stays a static key: the signer policy requires
 * every user-side account to be static (docs/ARCHITECTURE.md §12.1).
 */
export const compileV0 = (
  payer: Address,
  instructions: readonly Instruction[],
  recentBlockhash: Address,
  tables: readonly LookupTableInput[],
  lookupAllowed: (key: Address) => boolean,
): CompiledMessage => {
  const flags = new Map<Address, KeyFlags>();
  const note = (key: Address, f: Partial<KeyFlags>) => {
    const k = flags.get(key) ?? { signer: false, writable: false, invoked: false };
    flags.set(key, { signer: k.signer || !!f.signer, writable: k.writable || !!f.writable, invoked: k.invoked || !!f.invoked });
  };
  note(payer, { signer: true, writable: true });
  for (const ix of instructions) {
    note(ix.programId, { invoked: true });
    for (const a of ix.accounts) note(a.address, { signer: a.signer, writable: a.writable });
  }
  for (const [key, f] of flags) if (f.invoked && (f.writable || f.signer)) throw new RangeError(`program ${key} is also used as a writable or signer account`);

  // Keys a table may supply: not a signer, not invoked, allowed by the caller, present in a table (first table wins).
  const loaded = new Map<Address, { table: number; index: number }>();
  for (const [key, f] of flags) {
    if (f.signer || f.invoked || !lookupAllowed(key)) continue;
    for (let t = 0; t < tables.length && !loaded.has(key); t++) {
      const i = tables[t]!.addresses.indexOf(key);
      if (i >= 0 && i < MAX_INDEXABLE) loaded.set(key, { table: t, index: i });
    }
  }

  const statics = [...flags.entries()].filter(([k]) => !loaded.has(k));
  const group = (signer: boolean, writable: boolean) => statics.filter(([, f]) => f.signer === signer && f.writable === writable).map(([k]) => k);
  // The payer is the first writable signer (inserted first, and Map keeps insertion order).
  const staticKeys = [...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  if (staticKeys[0] !== payer) throw new Error('the fee payer must be the first static key');

  const lookups = tables
    .map((t, ti) => {
      const mine = [...loaded.entries()].filter(([, v]) => v.table === ti);
      return {
        table: t.address,
        writable: mine.filter(([k]) => flags.get(k)!.writable).map(([, v]) => v.index),
        readonly: mine.filter(([k]) => !flags.get(k)!.writable).map(([, v]) => v.index),
        keysW: mine.filter(([k]) => flags.get(k)!.writable).map(([k]) => k),
        keysR: mine.filter(([k]) => !flags.get(k)!.writable).map(([k]) => k),
      };
    })
    .filter((l) => l.writable.length + l.readonly.length > 0);
  // Account index order: static keys, then every table's writable keys, then every table's read-only keys.
  const order = [...staticKeys, ...lookups.flatMap((l) => l.keysW), ...lookups.flatMap((l) => l.keysR)];
  if (order.length > MAX_INDEXABLE) throw new RangeError(`${order.length} account keys; at most ${MAX_INDEXABLE} are addressable`);
  const indexOf = new Map(order.map((k, i) => [k, i] as const));

  const signers = staticKeys.filter((k) => flags.get(k)!.signer);
  const m = new Writer()
    .u8(V0_PREFIX)
    .u8(signers.length)
    .u8(signers.filter((k) => !flags.get(k)!.writable).length)
    .u8(staticKeys.filter((k) => !flags.get(k)!.signer && !flags.get(k)!.writable).length)
    .shortU16(staticKeys.length);
  for (const k of staticKeys) m.pubkey(k);
  m.pubkey(recentBlockhash).shortU16(instructions.length);
  for (const ix of instructions) {
    m.u8(indexOf.get(ix.programId)!).shortU16(ix.accounts.length);
    for (const a of ix.accounts) m.u8(indexOf.get(a.address)!);
    m.shortU16(ix.data.length).bytes(ix.data);
  }
  m.shortU16(lookups.length);
  for (const l of lookups) {
    m.pubkey(l.table).shortU16(l.writable.length).bytes(Uint8Array.from(l.writable)).shortU16(l.readonly.length).bytes(Uint8Array.from(l.readonly));
  }
  const message = m.done();
  const wire = new Writer().shortU16(signers.length).bytes(new Uint8Array(signers.length * SIGNATURE_BYTES)).bytes(message).done();
  if (wire.length > MAX_TRANSACTION_BYTES) throw new RangeError(`transaction is ${wire.length} bytes; the limit is ${MAX_TRANSACTION_BYTES}`);
  return {
    message,
    wire,
    staticKeys,
    lookups: lookups.map((l) => ({ table: l.table, writable: l.writable, readonly: l.readonly })),
  };
};
