// Rent for the accounts a trade may create, per SIMD-0437: (128 + data bytes) × lamports per byte, with the rate read
// live (getMinimumBalanceForRentExemption / the Rent sysvar; 5,080 since 2026-09-11 and falling again with Agave 4.4).
// Never a constant: docs/research/execution.md §6.
import { type Address, type Mint, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/index.ts';
import { SUPPORTED_MINT_EXTENSIONS } from './shape.ts';

/** Bytes every account is charged for on top of its data (the account metadata), SIMD-0437. */
export const ACCOUNT_STORAGE_OVERHEAD = 128n;
/** SPL Token account (and a Token-2022 account without extensions). */
export const TOKEN_ACCOUNT_SIZE = 165;
/** pump and PumpSwap `UserVolumeAccumulator` (execution.md F3; checked on chain). */
export const USER_VOLUME_ACCUMULATOR_SIZE = 137;

/**
 * The largest account a swap can create or top up at the wallet's expense: a Token-2022 ATA (170 bytes). The signer
 * policy charges every possible creation at this size, so it never depends on a caller's figure.
 */
export const MAX_CREATED_ACCOUNT_BYTES = 170;

/** Token-2022 account layout: base, the account-type byte, then TLV entries of 2 type + 2 length bytes + data. */
const T22_ACCOUNT_TYPE_BYTE = 1;
const TLV_HEADER = 4;
/** ImmutableOwner carries no data; the associated token program always adds it to Token-2022 accounts. */
const IMMUTABLE_OWNER_DATA = 0;


export interface RentRate {
  /** Lamports per byte-of-storage, read live. */
  readonly lamportsPerByte: bigint;
}

export const rentExempt = (dataBytes: number, rate: RentRate): bigint => {
  if (!Number.isInteger(dataBytes) || dataBytes < 0) throw new RangeError(`account size must be a non-negative integer, got ${dataBytes}`);
  if (rate.lamportsPerByte <= 0n) throw new RangeError('rent rate must be positive');
  return (ACCOUNT_STORAGE_OVERHEAD + BigInt(dataBytes)) * rate.lamportsPerByte;
};

export type AtaSizing = { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly reason: string };

/**
 * Size of a holder's associated token account for this mint: 165 bytes on SPL Token; on Token-2022, 165 + the
 * account-type byte + ImmutableOwner (170 for a pump `create_v2` coin, execution.md F2).
 */
export const associatedTokenAccountSize = (mint: Mint, tokenProgram: Address): AtaSizing => {
  if (tokenProgram === TOKEN_PROGRAM) {
    if (mint.program !== 'spl-token') return { ok: false, reason: 'mint is not an SPL Token mint' };
    return { ok: true, bytes: TOKEN_ACCOUNT_SIZE };
  }
  if (tokenProgram !== TOKEN_2022_PROGRAM || mint.program !== 'token-2022') return { ok: false, reason: 'token program does not own the mint' };
  // Any other extension either adds an account extension (transfer fee, hook, pausable, confidential,
  // non-transferable) or changes how amounts behave: refused rather than sized by guesswork.
  for (const ext of mint.extensions) {
    if (!SUPPORTED_MINT_EXTENSIONS.has(ext.kind)) return { ok: false, reason: `mint extension ${ext.kind} is not supported` };
  }
  return { ok: true, bytes: TOKEN_ACCOUNT_SIZE + T22_ACCOUNT_TYPE_BYTE + TLV_HEADER + IMMUTABLE_OWNER_DATA };
};
