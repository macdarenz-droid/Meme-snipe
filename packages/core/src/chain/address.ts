// Program-derived addresses, as solana-program `find_program_address`: sha256(seeds || bump || program || marker),
// taking the first bump from 255 down whose hash is NOT a valid ed25519 point.
import { createHash } from 'node:crypto';
import { decodeAddressBytes, encodeBase58 } from './base58.ts';
import type { Address } from './bytes.ts';

/** The ed25519 field prime 2^255 - 19 (RFC 8032 5.1; test/chain/address.test.ts recomputes it). */
export const ED25519_FIELD_PRIME = 57896044618658097711785492504343953926634992332820282019728792003956564819949n;
const P = ED25519_FIELD_PRIME;

const modPow = (base: bigint, exp: bigint): bigint => {
  let result = 1n;
  let b = ((base % P) + P) % P;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
};

/** The Edwards curve constant d = -121665 / 121666 mod p (RFC 8032 5.1; recomputed in test/chain/address.test.ts). */
export const ED25519_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const D = ED25519_D;

/**
 * True when 32 bytes decompress to an ed25519 point, matching curve25519-dalek `CompressedEdwardsY::decompress`
 * (what Solana's `bytes_are_curve_point` calls): y is the low 255 bits (reduced mod p), and the point exists
 * when (y² − 1) / (d·y² + 1) is a square mod p. The sign bit never makes a point invalid.
 */
export const isOnCurve = (bytes: Uint8Array): boolean => {
  if (bytes.length !== 32) throw new RangeError('a curve point is 32 bytes');
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  y %= P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const w = (u * modPow(v, P - 2n)) % P;
  if (w === 0n) return true;
  return modPow(w, (P - 1n) / 2n) === 1n;
};

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');
const MAX_SEED_LEN = 32;
const MAX_SEEDS = 16;

export type Seed = Uint8Array | string;
const seedBytes = (s: Seed): Uint8Array => (typeof s === 'string' ? new TextEncoder().encode(s) : s);

/** `create_program_address` with an explicit bump; null when the hash lands on the curve (no PDA for that bump). */
export const createProgramAddress = (seeds: readonly Seed[], programId: Address): Address | null => {
  if (seeds.length > MAX_SEEDS) throw new RangeError(`at most ${MAX_SEEDS} seeds`);
  const h = createHash('sha256');
  for (const s of seeds) {
    const b = seedBytes(s);
    if (b.length > MAX_SEED_LEN) throw new RangeError(`seed longer than ${MAX_SEED_LEN} bytes`);
    h.update(b);
  }
  h.update(decodeAddressBytes(programId));
  h.update(PDA_MARKER);
  const hash = new Uint8Array(h.digest());
  return isOnCurve(hash) ? null : (encodeBase58(hash) as Address);
};

export const findProgramAddress = (seeds: readonly Seed[], programId: Address): { address: Address; bump: number } => {
  if (seeds.length > MAX_SEEDS - 1) throw new RangeError(`at most ${MAX_SEEDS - 1} seeds plus the bump`);
  for (let bump = 255; bump >= 0; bump--) {
    const address = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (address) return { address, bump };
  }
  throw new Error('no viable bump seed');
};

/** Checks the base58 form and length; returns the branded address. */
export const toAddress = (text: string): Address => {
  decodeAddressBytes(text);
  return text as Address;
};

export const addressBytes = (a: Address): Uint8Array => decodeAddressBytes(a);
