// The RPC methods the gateway accepts and the parameter rules of A-M14-01 logic 4. A method missing from this table
// is refused (`E_RPC unknown_method`): the client must know where each method's configuration object sits before it
// can inject `commitment` and `maxSupportedTransactionVersion`.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62).
//
// VERIFY (A-M14-01 logic 4), read 2026-10-07 from the official method pages https://solana.com/docs/rpc/http/<name>.md
// (positional parameters, then the configuration object and its fields):
//   getAccountInfo [pubkey, {commitment, encoding (default "binary", deprecated), dataSlice, minContextSlot}]
//   getBalance [pubkey, {commitment, minContextSlot}]
//   getBlock [slot, {commitment: confirmed|finalized, encoding, transactionDetails, maxSupportedTransactionVersion, rewards}]
//   getBlockHeight [{commitment, minContextSlot}]
//   getHealth [] (no parameters)
//   getLatestBlockhash [{commitment, minContextSlot}]
//   getMultipleAccounts [pubkeys, {commitment, minContextSlot, dataSlice, encoding}]
//   getProgramAccounts [pubkey, {commitment, minContextSlot, withContext, encoding, dataSlice, filters, sortResults}]
//   getSignaturesForAddress [address, {commitment: confirmed|finalized, minContextSlot, limit, before, until}]
//   getSignatureStatuses [signatures, {searchTransactionHistory}] (no commitment)
//   getSlot [{commitment, minContextSlot}]
//   getTokenAccountBalance [pubkey, {commitment}]
//   getTransaction [signature, {commitment: confirmed|finalized, maxSupportedTransactionVersion, encoding}]
//   getVersion [] (no parameters)
//   sendTransaction [transaction, {encoding, skipPreflight, preflightCommitment, maxRetries, minContextSlot}] (no commitment)
// and https://www.helius.dev/docs/api-reference/priority-fee/getpriorityfeeestimate.md:
//   getPriorityFeeEstimate [{transaction | accountKeys, options}] (no commitment)
import type { Commitment } from '@bot/types';

/** Bucket classes of A-M14-02 logic 1. */
export type MethodClass = 'standard' | 'heavy' | 'send' | 'fee';

export interface MethodSpec {
  /** Index of the configuration object in `params`, or null for a method without one. */
  configIndex: number | null;
  /** Commitments the method accepts; empty when it takes none (then `commitment` must not be passed). */
  commitments: readonly Commitment[];
  /** The configuration must name an encoding (the default is a deprecated binary encoding [DA-06]). */
  encodingRequired: boolean;
  /** `maxSupportedTransactionVersion: 1` is always sent (version 0 or omission fails on v1 [LD-05, EX-V04]). */
  versioned: boolean;
  methodClass: MethodClass;
  /** The call role the method needs: only `sendTransaction` is a send. */
  role: 'read' | 'send';
}

const ALL: readonly Commitment[] = ['processed', 'confirmed', 'finalized'];
const CONFIRMED_UP: readonly Commitment[] = ['confirmed', 'finalized'];
const NONE: readonly Commitment[] = [];

const read = (configIndex: number | null, commitments: readonly Commitment[], extra: Partial<MethodSpec> = {}): MethodSpec => ({
  configIndex, commitments, encodingRequired: false, versioned: false, methodClass: 'standard', role: 'read', ...extra,
});

export const METHODS: Readonly<Record<string, MethodSpec>> = Object.freeze({
  getAccountInfo: read(1, ALL, { encodingRequired: true }),
  getBalance: read(1, ALL),
  getBlock: read(1, CONFIRMED_UP, { versioned: true, methodClass: 'heavy' }),
  getBlockHeight: read(0, ALL),
  getHealth: read(null, NONE),
  getLatestBlockhash: read(0, ALL),
  getMultipleAccounts: read(1, ALL, { encodingRequired: true }),
  getProgramAccounts: read(1, ALL, { encodingRequired: true, methodClass: 'heavy' }),
  getSignaturesForAddress: read(1, CONFIRMED_UP),
  getSignatureStatuses: read(1, NONE),
  getSlot: read(0, ALL),
  getTokenAccountBalance: read(1, ALL),
  getTransaction: read(1, CONFIRMED_UP, { versioned: true }),
  getVersion: read(null, NONE),
  getPriorityFeeEstimate: read(0, NONE, { methodClass: 'fee' }),
  sendTransaction: read(1, NONE, { methodClass: 'send', role: 'send' }),
});

export function methodSpec(method: string): MethodSpec | null {
  return Object.hasOwn(METHODS, method) ? METHODS[method] as MethodSpec : null;
}

/** Why a call's parameters were refused (`E_RPC` messages; programming errors in the caller). */
export type ParamProblem = 'unknown_method' | 'role_mismatch' | 'missing_commitment' | 'unsupported_commitment'
  | 'commitment_not_supported' | 'commitment_conflict' | 'missing_encoding' | 'bad_params';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Applies the parameter rules of A-M14-01 logic 4 and returns the parameters to send. The caller's array and objects
 * are never changed. `commitment` is injected into the configuration object; a different commitment already in it is
 * refused, so the value the caller asked for is the value sent.
 */
export function prepareParams(method: string, params: readonly unknown[], role: 'read' | 'send', commitment: Commitment | undefined):
  { ok: true; params: unknown[] } | { ok: false; problem: ParamProblem } {
  const spec = methodSpec(method);
  if (spec === null) return { ok: false, problem: 'unknown_method' };
  if (spec.role !== role) return { ok: false, problem: 'role_mismatch' };
  if (!Array.isArray(params)) return { ok: false, problem: 'bad_params' };
  if (spec.commitments.length === 0 && commitment !== undefined) return { ok: false, problem: 'commitment_not_supported' };
  if (spec.commitments.length > 0) {
    if (commitment === undefined) return { ok: false, problem: 'missing_commitment' };
    if (!spec.commitments.includes(commitment)) return { ok: false, problem: 'unsupported_commitment' };
  }
  const out = [...params];
  if (spec.configIndex === null) {
    return out.length === 0 ? { ok: true, params: out } : { ok: false, problem: 'bad_params' };
  }
  const at = spec.configIndex;
  if (out.length < at || out.length > at + 1) return { ok: false, problem: 'bad_params' };
  const given = out[at];
  if (given !== undefined && !isPlainObject(given)) return { ok: false, problem: 'bad_params' };
  const config: Record<string, unknown> = { ...given };
  if (spec.commitments.length > 0) {
    if (config.commitment !== undefined && config.commitment !== commitment) return { ok: false, problem: 'commitment_conflict' };
    config.commitment = commitment;
  }
  if (spec.encodingRequired && typeof config.encoding !== 'string') return { ok: false, problem: 'missing_encoding' };
  if (spec.versioned) config.maxSupportedTransactionVersion = 1;
  // A method with nothing to inject keeps its parameters as given (no empty configuration object is added).
  if (given !== undefined || Object.keys(config).length > 0) out[at] = config;
  return { ok: true, params: out };
}
