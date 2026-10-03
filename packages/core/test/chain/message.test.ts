// Golden vectors: every mainnet fixture transaction decoded from its wire bytes must equal the RPC's own parse of
// the same transaction (encoding "json"), and the fee payer's ed25519 signature must verify over the message
// bytes we cut out, which proves the message boundaries for all three formats.
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58 } from '../../src/chain/base58.ts';
import { DecodeError, fromBase64 } from '../../src/chain/bytes.ts';
import { type LoadedAddresses, type LookupTable, U64_MAX, accountKeys, decodeLookupTable, decodeTransaction, isSigner, isWritable, resolveLookups } from '../../src/chain/message.ts';
import type { Address } from '../../src/chain/bytes.ts';
import { ACCOUNTS, TRANSACTIONS } from './helpers.ts';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const verifies = (pubkey: Address, message: Uint8Array, signature: string) =>
  verify(null, message, createPublicKey({ key: Buffer.concat([SPKI_ED25519, decodeBase58(pubkey)]), format: 'der', type: 'spki' }), decodeBase58(signature));

describe('transactions from mainnet', () => {
  it('cover legacy, v0 with lookup tables, and v1', () => {
    const versions = new Set(TRANSACTIONS.map((t) => String(t.version)));
    expect(versions).toEqual(new Set(['legacy', '0', '1']));
    expect(TRANSACTIONS.some((t) => t.version === 0 && (t.jsonMessage.addressTableLookups?.length ?? 0) > 0)).toBe(true);
  });

  it.each(TRANSACTIONS.map((t) => [`${t.label} ${t.signature.slice(0, 8)}`, t] as const))('%s', (_n, t) => {
    const tx = decodeTransaction(fromBase64(t.base64.transaction[0]));
    const j = t.jsonMessage;
    expect(tx.version).toBe(t.version);
    expect(tx.signatures[0]).toBe(t.signature);
    expect(tx.header).toEqual(j.header);
    expect(tx.recentBlockhash).toBe(j.recentBlockhash);
    expect(tx.staticAccountKeys).toEqual(j.accountKeys);
    expect(tx.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: [...ix.accounts], data: encodeBase58(ix.data) }))).toEqual(
      j.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: ix.data })),
    );
    expect(tx.addressTableLookups).toEqual(j.addressTableLookups ?? []);
    tx.signatures.forEach((sig, i) => expect(verifies(tx.staticAccountKeys[i]!, tx.message, sig)).toBe(true));
    if (tx.version === 1) {
      // The RPC names the fields differently and prints unset ones as null.
      const c = j.transactionConfig as Record<string, number | null>;
      const opt = (v: number | null | undefined) => (v === null || v === undefined ? undefined : BigInt(v));
      expect(opt(tx.config?.priorityFeeLamports as never)).toBe(opt(c['priorityFee']));
      expect(opt(tx.config?.computeUnitLimit)).toBe(opt(c['computeUnitLimit']));
      expect(opt(tx.config?.loadedAccountsDataSizeLimit)).toBe(opt(c['loadedAccountsDataSizeLimit']));
      expect(opt(tx.config?.requestedHeapSize)).toBe(opt(c['heapSize']));
    }
  });
});

describe('address lookup tables', () => {
  const tables = ACCOUNTS.filter((a) => a.label === 'address lookup table');

  it.each(tables.map((a) => [a.address, a] as const))('%s matches the RPC parse', (_a, a) => {
    const t = decodeLookupTable(fromBase64(a.dataBase64));
    const info = a.parsed!.parsed.info as Record<string, unknown>;
    expect(t.addresses).toEqual(info['addresses']);
    expect(t.authority).toBe(info['authority'] ?? null);
    expect(t.deactivationSlot.toString()).toBe(info['deactivationSlot']);
    expect(t.lastExtendedSlot.toString()).toBe(info['lastExtendedSlot']);
    expect(t.lastExtendedSlotStartIndex).toBe(info['lastExtendedSlotStartIndex']);
  });

  it('resolve the v0 fixture to exactly the loaded addresses the node reported', () => {
    // The lookup tables were fetched for the transaction labelled for this check.
    const v0 = TRANSACTIONS.filter((t) => t.label.startsWith('v0 transaction with'));
    expect(v0.length).toBeGreaterThan(0);
    const map = new Map<string, LookupTable>(tables.map((a) => [a.address, decodeLookupTable(fromBase64(a.dataBase64))]));
    for (const t of v0) {
      const tx = decodeTransaction(fromBase64(t.base64.transaction[0]));
      // Tables only grow, so the tables read after the transaction resolve its indexes to the same keys.
      const readSlot = BigInt(Math.max(...tables.map((a) => a.slot))) + 1n;
      const loaded = resolveLookups(tx.addressTableLookups, map, readSlot);
      expect(loaded).toEqual(t.base64.meta.loadedAddresses);
      const keys = accountKeys(tx, loaded);
      expect(keys.length).toBe(tx.staticAccountKeys.length + loaded.writable.length + loaded.readonly.length);
      expect(isWritable(tx, tx.staticAccountKeys.length, loaded)).toBe(loaded.writable.length > 0);
      expect(isWritable(tx, keys.length - 1, loaded)).toBe(loaded.readonly.length === 0);
    }
  });

  it('refuses addresses added in the current slot, deactivated tables and missing tables', () => {
    const t: LookupTable = { deactivationSlot: U64_MAX, lastExtendedSlot: 100n, lastExtendedSlotStartIndex: 1, authority: null, addresses: ['A' as Address, 'B' as Address] };
    const lookup = [{ accountKey: 'T' as Address, writableIndexes: [1], readonlyIndexes: [] }];
    expect(() => resolveLookups(lookup, new Map([['T', t]]), 100n)).toThrow(DecodeError);
    expect(resolveLookups(lookup, new Map([['T', t]]), 101n).writable).toEqual(['B']);
    expect(() => resolveLookups(lookup, new Map([['T', { ...t, deactivationSlot: 5n }]]), 101n)).toThrow(DecodeError);
    expect(() => resolveLookups(lookup, new Map(), 101n)).toThrow(DecodeError);
  });
});

describe('loaded addresses must match the lookups', () => {
  const pumpV0 = TRANSACTIONS.find((t) => t.version === 0 && t.label.includes('TradeEvent') && (t.base64.meta.loadedAddresses?.writable.length ?? 0) > 0)!;
  const tx = decodeTransaction(fromBase64(pumpV0.base64.transaction[0]));
  const loaded = pumpV0.base64.meta.loadedAddresses! as unknown as LoadedAddresses;

  it('accepts the node-reported lists', () => {
    expect(accountKeys(tx, loaded).length).toBe(tx.staticAccountKeys.length + loaded.writable.length + loaded.readonly.length);
  });

  it('refuses a short list, swapped lists, missing lists, and keys for a transaction without lookups', () => {
    expect(() => accountKeys(tx, { writable: loaded.writable.slice(1), readonly: loaded.readonly })).toThrow(DecodeError);
    if (loaded.writable.length !== loaded.readonly.length) {
      expect(() => accountKeys(tx, { writable: loaded.readonly, readonly: loaded.writable })).toThrow(DecodeError);
    }
    expect(() => accountKeys(tx)).toThrow(DecodeError);
    const legacy = decodeTransaction(fromBase64(TRANSACTIONS.find((t) => t.version === 'legacy')!.base64.transaction[0]));
    expect(() => accountKeys(legacy, loaded)).toThrow(DecodeError);
    expect(accountKeys(legacy, { writable: [], readonly: [] })).toEqual(legacy.staticAccountKeys);
  });

  it('isWritable and isSigner refuse out-of-range indexes', () => {
    expect(() => isWritable(tx, -1, loaded)).toThrow(RangeError);
    expect(() => isWritable(tx, accountKeys(tx, loaded).length, loaded)).toThrow(RangeError);
    expect(() => isSigner(tx, -1)).toThrow(RangeError);
    expect(isWritable(tx, 0, loaded)).toBe(true);
    expect(isSigner(tx, 0)).toBe(true);
  });
});

/** A minimal legacy transaction: one signature (zeros), the given header, keys and one instruction. */
const legacyTx = (opts: { nSig?: number; header?: [number, number, number]; keys?: number; program?: number; accounts?: number[] }) => {
  const nSig = opts.nSig ?? 1;
  const [req, ros, rou] = opts.header ?? [1, 0, 1];
  const keys = opts.keys ?? 2;
  const program = opts.program ?? 1;
  const accounts = opts.accounts ?? [0];
  return Uint8Array.from([
    nSig, ...new Array(64 * nSig).fill(0),
    req, ros, rou,
    keys, ...Array.from({ length: keys }, (_, i) => new Array(32).fill(i + 1)).flat(),
    ...new Array(32).fill(9),
    1, program, accounts.length, ...accounts, 0,
  ]);
};

describe('message sanitize rules (agave)', () => {
  it('accepts a well-formed minimal transaction', () => {
    expect(decodeTransaction(legacyTx({})).staticAccountKeys).toHaveLength(2);
  });

  it.each([
    ['no signatures', { nSig: 0, header: [0, 0, 1] as [number, number, number] }],
    ['a read-only fee payer', { header: [1, 1, 1] as [number, number, number] }],
    ['header counts above the keys', { header: [1, 0, 2] as [number, number, number] }],
    ['the fee payer as the program', { program: 0 }],
    ['a program index past the keys', { program: 2 }],
    ['an account index past the keys', { accounts: [2] }],
    ['a signature count that differs from the header', { nSig: 2 }],
  ])('refuses %s', (_n, opts) => {
    expect(() => decodeTransaction(legacyTx(opts))).toThrow(DecodeError);
  });

  it('refuses a v0 lookup that loads nothing, and more than 256 account keys in total', () => {
    // v0 message: prefix, header, 2 static keys, blockhash, one instruction, then the lookups.
    const v0 = (lookups: [number, number][]) =>
      Uint8Array.from([
        1, ...new Array(64).fill(0),
        0x80, 1, 0, 1,
        2, ...new Array(32).fill(1), ...new Array(32).fill(2),
        ...new Array(32).fill(9),
        1, 1, 1, 0, 0,
        lookups.length,
        ...lookups.flatMap(([w, r]) => [
          ...new Array(32).fill(7),
          ...shortVec(w), ...Array.from({ length: w }, (_, i) => i & 0xff),
          ...shortVec(r), ...Array.from({ length: r }, (_, i) => i & 0xff),
        ]),
      ]);
    const shortVec = (n: number) => (n < 128 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
    expect(decodeTransaction(v0([[1, 0]])).addressTableLookups).toHaveLength(1);
    expect(() => decodeTransaction(v0([[0, 0]]))).toThrow(/loads no accounts/);
    expect(decodeTransaction(v0([[200, 54]])).addressTableLookups).toHaveLength(1);
    expect(() => decodeTransaction(v0([[200, 55]]))).toThrow(/at most 256/);
  });

  it('reads a v1 requested heap size (mask bit 4) and every other config value', () => {
    const v1 = TRANSACTIONS.find((t) => t.version === 1)!;
    const b = fromBase64(v1.base64.transaction[0]);
    const tx = decodeTransaction(b);
    // Rebuild the same message with bit 4 set and a heap size of 65536 inserted after the existing values.
    const mask = b[4]! | (b[5]! << 8);
    const configStart = 1 + 3 + 4 + 32 + 1 + 1 + 32 * tx.staticAccountKeys.length;
    const configLen = ((mask & 3) === 3 ? 8 : 0) + (mask & 4 ? 4 : 0) + (mask & 8 ? 4 : 0);
    const withHeap = Uint8Array.from([...b.subarray(0, configStart + configLen), 0, 0, 1, 0, ...b.subarray(configStart + configLen)]);
    withHeap[4] = mask | 0x10;
    const d = decodeTransaction(withHeap);
    expect(d.config).toEqual({ ...tx.config, requestedHeapSize: 65536 });
  });
});

describe('malformed transactions', () => {
  const legacy = TRANSACTIONS.find((t) => t.version === 'legacy')!;
  const bytes = () => fromBase64(legacy.base64.transaction[0]);

  it('rejects trailing bytes, truncation and unknown versions', () => {
    expect(() => decodeTransaction(Uint8Array.from([...bytes(), 0]))).toThrow(DecodeError);
    expect(() => decodeTransaction(bytes().subarray(0, bytes().length - 1))).toThrow(DecodeError);
    const b = bytes();
    const msgStart = 1 + 64 * b[0]!;
    b[msgStart] = 0x82;
    expect(() => decodeTransaction(b)).toThrow(DecodeError);
  });

  it('rejects a v1 config mask with unknown bits or half a priority fee', () => {
    const v1 = TRANSACTIONS.find((t) => t.version === 1)!;
    const b = fromBase64(v1.base64.transaction[0]);
    b[4] = (b[4]! | 0x20) & 0xff;
    expect(() => decodeTransaction(b)).toThrow(DecodeError);
    const c = fromBase64(v1.base64.transaction[0]);
    c[4] = 0b01;
    expect(() => decodeTransaction(c)).toThrow(DecodeError);
  });
});
