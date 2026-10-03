// System program SOL transfers in a transaction (top-level and inner), for the insider precompute's first-funder
// lookup (H13, docs/ARCHITECTURE.md §16.3). Live fetches a wallet's oldest transaction and the backtest reads the
// dataset's first funding transaction; both read it here, so the funder is decided by one decoder.
// Layouts: solana-program system_instruction.rs (bincode, u32 LE tag): 0 CreateAccount {lamports u64, space u64, owner},
// 2 Transfer {lamports u64}, 3 CreateAccountWithSeed {base, seed string, lamports u64, ...}, 11 TransferWithSeed
// {lamports u64, from_seed string, from_owner}. Accounts: CreateAccount [from, to]; CreateAccountWithSeed [from, to, base];
// Transfer [from, to]; TransferWithSeed [from, base, to].
import { DecodeError } from './bytes.ts';
import { accountKeys, decodeTransaction } from './message.ts';
import { SYSTEM_PROGRAM } from './programs.ts';
import type { TransactionRecord } from './transaction.ts';

export interface SolTransfer {
  readonly from: string;
  readonly to: string;
  readonly lamports: bigint;
  readonly outerIx: number;
  /** -1 for a top-level instruction. */
  readonly innerIx: number;
}

const view = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u32 = (d: Uint8Array, o: number): number => view(d).getUint32(o, true);
const u64 = (d: Uint8Array, o: number): bigint => view(d).getBigUint64(o, true);

/** One system instruction as a transfer, or null when it moves no SOL between accounts we can name. */
const transferOf = (data: Uint8Array, accounts: readonly number[], keys: readonly string[]): { from: string; to: string; lamports: bigint } | null => {
  if (data.length < 12) return null;
  const tag = u32(data, 0);
  const key = (i: number): string => {
    const k = keys[accounts[i]!];
    if (k === undefined) throw new DecodeError(`system instruction account ${i} is out of range`);
    return k;
  };
  switch (tag) {
    case 0: // CreateAccount: 4 + 8 + 8 + 32
      if (data.length !== 52 || accounts.length < 2) return null;
      return { from: key(0), to: key(1), lamports: u64(data, 4) };
    case 2: // Transfer
      if (data.length !== 12 || accounts.length < 2) return null;
      return { from: key(0), to: key(1), lamports: u64(data, 4) };
    case 3: { // CreateAccountWithSeed: base(32), seed (u64 len + bytes), lamports, space, owner
      if (data.length < 4 + 32 + 8 || accounts.length < 2) return null;
      const len = u64(data, 36);
      const at = 44 + Number(len);
      if (len > 32n || data.length !== at + 8 + 8 + 32) return null;
      return { from: key(0), to: key(1), lamports: u64(data, at) };
    }
    case 11: { // TransferWithSeed: lamports, seed (u64 len + bytes), owner(32)
      if (accounts.length < 3) return null;
      const len = u64(data, 12);
      if (len > 32n || data.length !== 20 + Number(len) + 32) return null;
      return { from: key(0), to: key(2), lamports: u64(data, 4) };
    }
    default:
      return null;
  }
};

/** Every SOL transfer the System program made in a successful transaction, in execution order. Failed: none. */
export const systemTransfers = (rec: TransactionRecord): SolTransfer[] => {
  if (rec.err !== null && rec.err !== undefined) return [];
  const tx = decodeTransaction(rec.transaction);
  if (tx.signatures[0] !== rec.signature) throw new DecodeError(`record signature ${rec.signature} does not match the transaction`);
  const keys = accountKeys(tx, rec.loadedAddresses);
  const inner = new Map((rec.innerInstructions ?? []).map((g) => [g.index, g.instructions]));
  const out: SolTransfer[] = [];
  tx.instructions.forEach((ix, outerIx) => {
    if (keys[ix.programIdIndex] === SYSTEM_PROGRAM) {
      const t = transferOf(ix.data, ix.accounts, keys);
      if (t !== null) out.push({ ...t, outerIx, innerIx: -1 });
    }
    (inner.get(outerIx) ?? []).forEach((c, innerIx) => {
      if (keys[c.programIdIndex] !== SYSTEM_PROGRAM) return;
      const t = transferOf(c.data, c.accounts, keys);
      if (t !== null) out.push({ ...t, outerIx, innerIx });
    });
  });
  return out;
};

/**
 * The first SOL transfer into `wallet` from another account in this transaction, or null. Read from the wallet's
 * oldest transaction, it names who funded the wallet first. A transaction recorded without inner instructions is
 * refused: a funding made through a program call could be missed.
 */
export const firstFunder = (rec: TransactionRecord, wallet: string): SolTransfer | null => {
  if (rec.innerInstructions === null) throw new DecodeError(`transaction ${rec.signature} has no inner instructions recorded`);
  return systemTransfers(rec).find((t) => t.to === wallet && t.from !== wallet && t.lamports > 0n) ?? null;
};
