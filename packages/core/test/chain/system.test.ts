// System program SOL transfers (FACTS-1 first-funder lookup): real mainnet oldest transactions of first buyers
// (test/facts/fixtures/facts.json), and each instruction layout from solana-program's system_instruction.rs.
import { describe, expect, it } from 'vitest';
import { encodeBase58, firstFunder, recordFromRpc, systemTransfers, type TransactionRecord } from '../../src/chain/index.ts';
import { FIX } from '../facts/helpers.ts';

const oldest = FIX.transactions.filter((t) => t.label === 'oldest transaction of a first buyer');

describe('system transfers', () => {
  it('reads the first funding transfer of real first buyers, and agrees with the recorded funder', () => {
    expect(oldest.length).toBeGreaterThan(0);
    let named = 0;
    for (const t of oldest) {
      const rec = recordFromRpc(t.signature, t.base64);
      const f = FIX.funders.find((x) => x.signature === t.signature);
      const wallet = f?.wallet ?? FIX.funders.find((x) => x.complete && x.slot === t.slot)?.wallet;
      if (wallet === undefined) continue;
      const got = firstFunder(rec, wallet);
      expect(got?.from ?? null).toBe(f?.funder ?? null);
      if (got !== null) {
        expect(got.to).toBe(wallet);
        expect(got.lamports).toBeGreaterThan(0n);
        named++;
      }
    }
    expect(named).toBeGreaterThan(0);
  });

  it('a failed transaction moves no SOL; a record without inner instructions is refused', () => {
    const t = oldest[0]!;
    const rec = recordFromRpc(t.signature, t.base64);
    expect(systemTransfers({ ...rec, err: { InstructionError: [0, 'Custom'] } })).toEqual([]);
    expect(() => firstFunder({ ...rec, innerInstructions: null }, 'x')).toThrow(/inner instructions/);
  });
});

/** A legacy transaction with one System instruction, built byte by byte (message format: solana.com docs). */
const build = (data: Uint8Array, accounts: number[], keys: Uint8Array[]): TransactionRecord => {
  const sig = new Uint8Array(64).fill(7);
  const msg: number[] = [1, 0, 1, keys.length, ...keys.flatMap((k) => [...k]), ...new Array(32).fill(1), 1, keys.length - 1, accounts.length, ...accounts, data.length, ...data];
  const wire = Uint8Array.from([1, ...sig, ...msg]);
  return { slot: 1n, blockTime: 1, txIndex: 0, signature: encodeBase58(sig), transaction: wire, err: null, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [], logMessages: [] };
};
const key = (n: number) => new Uint8Array(32).fill(n);
const SYSTEM = new Uint8Array(32);
const le = (v: bigint, n: number) => Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));

describe('system instruction layouts', () => {
  const from = key(9);
  const to = key(8);
  const base = key(6);

  it('Transfer (2) and CreateAccount (0) move lamports from the first account to the second', () => {
    const t = systemTransfers(build(Uint8Array.from([...le(2n, 4), ...le(1_500_000n, 8)]), [0, 1], [from, to, SYSTEM]));
    expect(t).toEqual([{ from: encodeBase58(from), to: encodeBase58(to), lamports: 1_500_000n, outerIx: 0, innerIx: -1 }]);
    const c = systemTransfers(build(Uint8Array.from([...le(0n, 4), ...le(2_039_280n, 8), ...le(165n, 8), ...key(5)]), [0, 1], [from, to, SYSTEM]));
    expect(c[0]).toMatchObject({ to: encodeBase58(to), lamports: 2_039_280n });
  });

  it('TransferWithSeed (11) pays the third account', () => {
    const seed = [...le(3n, 8), 97, 98, 99];
    const t = systemTransfers(build(Uint8Array.from([...le(11n, 4), ...le(7n, 8), ...seed, ...key(4)]), [0, 1, 2], [from, base, to, SYSTEM]));
    expect(t).toEqual([{ from: encodeBase58(from), to: encodeBase58(to), lamports: 7n, outerIx: 0, innerIx: -1 }]);
  });

  it('a truncated or oversized instruction moves nothing', () => {
    expect(systemTransfers(build(Uint8Array.from([...le(2n, 4), ...le(1n, 7)]), [0, 1], [from, to, SYSTEM]))).toEqual([]);
    expect(systemTransfers(build(Uint8Array.from([...le(2n, 4), ...le(1n, 8), 0]), [0, 1], [from, to, SYSTEM]))).toEqual([]);
    expect(systemTransfers(build(Uint8Array.from([...le(9n, 4), ...le(1n, 8)]), [0, 1], [from, to, SYSTEM]))).toEqual([]);
  });

  it('a transfer from the wallet to itself is not its funding', () => {
    const self = build(Uint8Array.from([...le(2n, 4), ...le(5n, 8)]), [0, 0], [from, SYSTEM]);
    expect(firstFunder(self, encodeBase58(from))).toBeNull();
  });
});
