// Lossless JSON for RPC answers. JSON numbers above 2^53 (lamports, token amounts) lose precision in JSON.parse, and
// on-chain quantities must never be silently rounded (ARCH 5.0). An integer that is not a safe integer is returned as
// a bigint read from its source text; safe integers and fractions stay numbers.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62).

const LONG_DIGITS = /\d{16}/;
const INTEGER = /^-?\d+$/;

type Reviver = (this: unknown, key: string, value: unknown, context: { source: string }) => unknown;

const revive: Reviver = (_key, value, context) =>
  typeof value === 'number' && !Number.isSafeInteger(value) && INTEGER.test(context.source) ? BigInt(context.source) : value;

/** JSON.parse that keeps integers beyond 2^53 exact (as bigint). Throws a SyntaxError on invalid JSON. */
export function parseJsonLossless(text: string): unknown {
  if (!LONG_DIGITS.test(text)) return JSON.parse(text);
  // Node 22 (V8 12.4) passes the source text to the reviver (JSON.parse source text access).
  return JSON.parse(text, revive as unknown as (this: unknown, key: string, value: unknown) => unknown);
}
