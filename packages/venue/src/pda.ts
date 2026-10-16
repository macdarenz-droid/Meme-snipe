// Program-derived addresses with Node built-ins only (card Z10, plan Q1): the recorder runs on the host from a
// `git archive` of this repository with no node_modules, so @solana/kit cannot load there. Same rule as the Solana
// runtime's `Pubkey::find_program_address`: for bump 255 down to 0, sha256(seeds ‖ [bump] ‖ program ‖
// "ProgramDerivedAddress"); the first hash that is NOT a valid compressed Ed25519 point is the address.
//
// On-curve test as curve25519-dalek's `CompressedEdwardsY::decompress` (which the runtime calls): y is the low 255
// bits (not reduced-checked), x² = (y² − 1) / (d·y² + 1) mod p, and the point decompresses exactly when that ratio is a
// square mod p (Euler's criterion). VERIFY against the dalek source was not done from this container; the cross-check
// test (test/pda.test.ts) compares with @solana/kit 8.3.0 on 10,000 random seed sets and on every PDA in constants.ts.
// Not constant-time, and it need not be (ruling Z10-4): seeds, program ids and addresses are all public data.
import { createHash } from 'node:crypto';
import { base58, decodePubkey } from '@bot/decoders';
import type { Pubkey } from '@bot/types';

export type PdaSeed = string | Uint8Array;
export const MAX_SEEDS = 16;
export const MAX_SEED_BYTES = 32;

const P = 2n ** 255n - 19n;
const mod = (a: bigint): bigint => ((a % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  let x = mod(b);
  let k = e;
  while (k > 0n) {
    if (k & 1n) r = (r * x) % P;
    x = (x * x) % P;
    k >>= 1n;
  }
  return r;
}
const inv = (a: bigint): bigint => pow(a, P - 2n);
/** d = −121665 / 121666 mod p (RFC 8032 §5.1). */
const D = mod(-121665n * inv(121666n));

/** True when the 32 bytes decompress to a point of Ed25519 (dalek's rule: any square ratio, sign bit ignored). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i] as number);
  y &= (1n << 255n) - 1n;
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const w = (u * inv(v)) % P;
  if (w === 0n) return true;
  return pow(w, (P - 1n) / 2n) === 1n;
}

const MARKER = new TextEncoder().encode('ProgramDerivedAddress');

export function createProgramAddress(program: Pubkey, seeds: readonly Uint8Array[]): Pubkey | null {
  const h = createHash('sha256');
  for (const s of seeds) h.update(s);
  h.update(decodePubkey(program)).update(MARKER);
  const out = new Uint8Array(h.digest());
  return isOnCurve(out) ? null : (base58.encode(out) as Pubkey);
}

export function findProgramAddress(program: Pubkey, seeds: readonly PdaSeed[]): { address: Pubkey; bump: number } {
  const bytes = seeds.map((s) => (typeof s === 'string' ? new TextEncoder().encode(s) : s));
  if (bytes.length > MAX_SEEDS - 1) throw new RangeError(`pda: at most ${MAX_SEEDS - 1} seeds before the bump`);
  for (const b of bytes) if (b.length > MAX_SEED_BYTES) throw new RangeError(`pda: a seed is at most ${MAX_SEED_BYTES} bytes`);
  for (let bump = 255; bump >= 0; bump--) {
    const address = createProgramAddress(program, [...bytes, Uint8Array.of(bump)]);
    if (address !== null) return { address, bump };
  }
  throw new RangeError('pda: no viable bump');
}
