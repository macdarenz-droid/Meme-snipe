// Native-program instructions the builders use: System transfer, SPL Token / Token-2022 SyncNative and CloseAccount,
// associated-token CreateIdempotent, and the two Compute Budget instructions. Layouts are the programs' own
// (system_instruction.rs, token instruction.rs, associated-token-account instruction.rs, compute-budget), and each is
// checked byte for byte against real mainnet transactions in test/tx/golden.test.ts.
import { type Address, SYSTEM_PROGRAM } from '../chain/index.ts';
import { type Instruction, Writer, ro, signerW, w } from './instruction.ts';
import { ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM } from './programs.ts';

/** System program instruction tags (u32 LE). */
export const SYSTEM_TRANSFER = 2;
/** Token program instruction tags (one byte; the same for SPL Token and Token-2022). */
export const TOKEN_CLOSE_ACCOUNT = 9;
export const TOKEN_SYNC_NATIVE = 17;
/** Associated-token-account instruction tag: CreateIdempotent. */
export const ATA_CREATE_IDEMPOTENT = 1;
/** Compute Budget instruction tags. */
export const CB_SET_COMPUTE_UNIT_LIMIT = 2;
export const CB_SET_COMPUTE_UNIT_PRICE = 3;

/** `extra` read-only accounts ride along (the jitodontfront marker); the System program ignores them. */
export const transfer = (from: Address, to: Address, lamports: bigint, extra: readonly Address[] = []): Instruction => {
  if (lamports <= 0n) throw new RangeError('a transfer moves at least one lamport');
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [signerW(from), w(to), ...extra.map(ro)],
    data: new Writer().u32(SYSTEM_TRANSFER).u64(lamports).done(),
  };
};

export const createAssociatedTokenIdempotent = (payer: Address, ata: Address, owner: Address, mint: Address, tokenProgram: Address): Instruction => ({
  programId: ASSOCIATED_TOKEN_PROGRAM,
  accounts: [signerW(payer), w(ata), ro(owner), ro(mint), ro(SYSTEM_PROGRAM), ro(tokenProgram)],
  data: Uint8Array.of(ATA_CREATE_IDEMPOTENT),
});

export const syncNative = (account: Address, tokenProgram: Address): Instruction => ({
  programId: tokenProgram,
  accounts: [w(account)],
  data: Uint8Array.of(TOKEN_SYNC_NATIVE),
});

/** Closes a zero-balance token account (or a wrapped-SOL account) and returns its lamports to `destination`. */
export const closeAccount = (account: Address, destination: Address, owner: Address, tokenProgram: Address): Instruction => ({
  programId: tokenProgram,
  accounts: [w(account), w(destination), { address: owner, signer: true, writable: false }],
  data: Uint8Array.of(TOKEN_CLOSE_ACCOUNT),
});

export const setComputeUnitLimit = (units: number): Instruction => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  accounts: [],
  data: new Writer().u8(CB_SET_COMPUTE_UNIT_LIMIT).u32(units).done(),
});

export const setComputeUnitPrice = (microLamportsPerUnit: bigint): Instruction => ({
  programId: COMPUTE_BUDGET_PROGRAM,
  accounts: [],
  data: new Writer().u8(CB_SET_COMPUTE_UNIT_PRICE).u64(microLamportsPerUnit).done(),
});
