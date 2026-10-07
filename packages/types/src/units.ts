// Unit helpers and decimal-string codecs (B-M19-01 logic 1; ARCH 5.0; UI.md "Conventions (normative)" 2 and 5).
// The helpers are runtime guards: they return the value unchanged when it is a valid quantity of the unit and
// throw (programmer error, SPEC-B convention 2) otherwise. Error messages never echo the value.
// The parsers read untrusted text, so they return a Result instead of throwing.
import type {
  BaseUnits, BlockHeight, Bps, Cu, Lamports, MicroLamportsPerCu, Result, SignedLamports, Slot, Unit, UnixMs,
} from './types.ts';

export const U64_MAX = 18_446_744_073_709_551_615n;                          // 2^64 − 1
export const I64_MIN = -9_223_372_036_854_775_808n;                          // −2^63
export const I64_MAX = 9_223_372_036_854_775_807n;                           // 2^63 − 1
export const I128_MIN = -170_141_183_460_469_231_731_687_303_715_884_105_728n; // −2^127
export const I128_MAX = 170_141_183_460_469_231_731_687_303_715_884_105_727n;  // 2^127 − 1
export const CU_MAX_PER_TX = 1_400_000;                                       // [LD-02]
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;                                // [LD-02]

function inRange(x: bigint, min: bigint, max: bigint, what: string): bigint {
  if (typeof x !== 'bigint') throw new TypeError(`${what}: expected a bigint`);
  if (x < min || x > max) throw new RangeError(`${what}: out of range`);
  return x;
}

function integerInRange(x: number, min: number, max: number, what: string): number {
  if (typeof x !== 'number' || !Number.isInteger(x)) throw new TypeError(`${what}: expected an integer number`);
  if (x < min || x > max) throw new RangeError(`${what}: out of range`);
  return x;
}

/** Lamports: u64. */
export function lamports(x: bigint): Lamports { return inRange(x, 0n, U64_MAX, 'Lamports'); }
/** Signed lamports (PnL, deltas): i64. */
export function signedLamports(x: bigint): SignedLamports { return inRange(x, I64_MIN, I64_MAX, 'SignedLamports'); }
/** Raw token amount: u64. */
export function baseUnits(x: bigint): BaseUnits { return inRange(x, 0n, U64_MAX, 'BaseUnits'); }
/** Compute-unit price: u64 micro-lamports per CU. */
export function microLamportsPerCu(x: bigint): MicroLamportsPerCu { return inRange(x, 0n, U64_MAX, 'MicroLamportsPerCu'); }
/** Slot: u64. */
export function slot(x: bigint): Slot { return inRange(x, 0n, U64_MAX, 'Slot'); }
/** Block height: u64. */
export function blockHeight(x: bigint): BlockHeight { return inRange(x, 0n, U64_MAX, 'BlockHeight'); }
/** Compute units: integer 0..1,400,000 per transaction [LD-02]. */
export function cu(x: number): Cu { return integerInRange(x, 0, CU_MAX_PER_TX, 'Cu'); }
/** Basis points: integer, int32 on the wire (UI.md convention 4); signed values are allowed. */
export function bps(x: number): Bps { return integerInRange(x, I32_MIN, I32_MAX, 'Bps'); }
/** Epoch milliseconds UTC: non-negative safe integer. */
export function unixMs(x: number): UnixMs { return integerInRange(x, 0, Number.MAX_SAFE_INTEGER, 'UnixMs'); }

/**
 * Prioritization fee in lamports = ceil(cuPrice × cuLimit / 1,000,000), on the REQUESTED limit [LD-02].
 * The single implementation of the formula (ARCH 5.0b I-19). Throws if an input is not a valid quantity or the
 * fee does not fit in u64.
 */
export function priorityFeeLamports(cuPrice: MicroLamportsPerCu, cuLimit: Cu): Lamports {
  const product = microLamportsPerCu(cuPrice) * BigInt(cu(cuLimit));
  const fee = (product + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;   // ceil for non-negative values
  return lamports(fee);
}

// ---- decimal-string codecs (UI.md convention 5) ----
export type U64Str = Unit<string, 'U64Str'>;
export type I64Str = Unit<string, 'I64Str'>;
export type I128Str = Unit<string, 'I128Str'>;
export type CodecError = { code: 'E_FORMAT' | 'E_RANGE' };

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const I64_RE = /^-?(0|[1-9][0-9]{0,18})$/;
const I128_RE = /^-?(0|[1-9][0-9]{0,38})$/;

function parse(s: unknown, re: RegExp, min: bigint, max: bigint): Result<bigint, CodecError> {
  // "-0" matches the signed patterns but is not the canonical text of any value, so it is rejected.
  if (typeof s !== 'string' || !re.test(s) || s === '-0') return { ok: false, error: { code: 'E_FORMAT' } };
  const value = BigInt(s);
  if (value < min || value > max) return { ok: false, error: { code: 'E_RANGE' } };
  return { ok: true, value };
}

export function toU64Str(x: bigint): U64Str { return inRange(x, 0n, U64_MAX, 'U64Str').toString(); }
export function fromU64Str(s: unknown): Result<bigint, CodecError> { return parse(s, U64_RE, 0n, U64_MAX); }
export function toI64Str(x: bigint): I64Str { return inRange(x, I64_MIN, I64_MAX, 'I64Str').toString(); }
export function fromI64Str(s: unknown): Result<bigint, CodecError> { return parse(s, I64_RE, I64_MIN, I64_MAX); }
export function toI128Str(x: bigint): I128Str { return inRange(x, I128_MIN, I128_MAX, 'I128Str').toString(); }
export function fromI128Str(s: unknown): Result<bigint, CodecError> { return parse(s, I128_RE, I128_MIN, I128_MAX); }
