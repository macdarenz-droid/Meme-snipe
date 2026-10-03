// The landing client as effect descriptions (docs/ARCHITECTURE.md §10, execution.md §4.4). CORE-1's intent reducer
// decides when to broadcast, check status, expire and replace; this module turns those effects into exact JSON-RPC
// requests and turns the answers back into lifecycle events. No I/O here: adapters/ performs the requests.
//
// Rules enforced:
// - a broadcast sends the identical stored signed bytes, checked against the attempt's signature and blockhash,
//   to Helius Sender (SWQoS-only, mev-protect) and our RPC in parallel, with skipPreflight and maxRetries 0;
// - status reads map commitment levels exactly as CORE-1 expects (a failure is terminal only at finalized there);
// - a replacement (a new signature, a new blockhash) is allowed only once the intent is reconciled without a fill
//   and every earlier attempt is provably dead: never a blind resend while an old blockhash is live.
import { type Address, decodeTransaction, toBase64 } from '../chain/index.ts';
import type { Commitment, Signature, TransactionAttempt } from '../domain/index.ts';
import { type Effect, type IntentEvent, type IntentState, isAttemptDead, isResolvedUnfilled } from '../lifecycle/index.ts';

export class LandingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LandingError';
  }
}

export interface LandingEndpoints {
  /** Helius Sender regional endpoint, e.g. https://fra-sender.helius-rpc.com/fast (no key needed). */
  readonly senderUrl: string;
  /** Our RPC (it carries its key in the URL; the URL is configuration, never logged by this module). */
  readonly rpcUrl: string;
}

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

export type Path = 'sender' | 'rpc';

export interface HttpCall {
  readonly path: Path;
  readonly url: string;
  readonly body: JsonRpcRequest;
}

const rpc = (method: string, params: readonly unknown[]): JsonRpcRequest => ({ jsonrpc: '2.0', id: 1, method, params });

/** Sender query flags: SWQoS-only routing (5,000-lamport tip, no credits) and Helius MEV protection (§10). */
export const senderUrl = (base: string): string => `${base}${base.includes('?') ? '&' : '?'}swqos_only=true&mev-protect=true`;

/**
 * Requests for a CORE-1 `broadcast` effect. `signedBytes` are the stored bytes behind `effect.signedBytesRef`; they
 * must carry exactly the attempt's signature and blockhash, or nothing is sent.
 */
export const planBroadcast = (
  effect: Extract<Effect, { type: 'broadcast' }>,
  attempt: TransactionAttempt,
  signedBytes: Uint8Array,
  endpoints: LandingEndpoints,
): readonly HttpCall[] => {
  if (attempt.id !== effect.attemptId || attempt.signature !== effect.signature || attempt.signedBytesRef !== effect.signedBytesRef) {
    throw new LandingError('broadcast effect does not match the stored attempt');
  }
  const tx = decodeTransaction(signedBytes);
  if (tx.signatures[0] !== effect.signature) throw new LandingError('stored bytes do not carry the attempt signature');
  if (tx.recentBlockhash !== (attempt.blockhash as string as Address)) throw new LandingError('stored bytes carry a different blockhash than the attempt');
  if (tx.signatures.some((s) => /^1+$/.test(s))) throw new LandingError('stored bytes are not fully signed');
  const body = rpc('sendTransaction', [toBase64(signedBytes), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
  return [
    { path: 'sender', url: senderUrl(endpoints.senderUrl), body },
    { path: 'rpc', url: endpoints.rpcUrl, body },
  ];
};

export type SendOutcome =
  | { readonly path: Path; readonly kind: 'accepted'; readonly signature: string }
  | { readonly path: Path; readonly kind: 'error'; readonly message: string }
  | { readonly path: Path; readonly kind: 'timeout' };

/**
 * One lifecycle event for one broadcast round. Accepted on any path means accepted for processing, never filled.
 * A path that answers with a different signature is a bug or an attack: it is an error, never an acceptance.
 */
export const sendEvent = (outcomes: readonly SendOutcome[], expected: Signature): IntentEvent => {
  if (outcomes.length === 0) throw new LandingError('no send outcomes');
  if (outcomes.some((o) => o.kind === 'accepted' && o.signature === expected)) return { type: 'send_accepted' };
  if (outcomes.some((o) => o.kind === 'timeout')) return { type: 'send_timeout' };
  const message = outcomes
    .map((o) => (o.kind === 'error' ? `${o.path}: ${o.message}` : o.kind === 'accepted' ? `${o.path}: answered signature ${o.signature}` : `${o.path}: timeout`))
    .join('; ');
  return { type: 'send_error', message };
};

/**
 * Requests for a CORE-1 `check_status` effect, in this order: first one `getEpochInfo` at `confirmed` (its slot and
 * block height come from the same node in one answer), then, only after it has answered, the statuses. The events
 * carry that block height, and a status answer counts only if its `context.slot` is at least that slot.
 *
 * Why: CORE-1 expires an attempt on "not found after a history search" once the height is past lastValidBlockHeight.
 * A height read after the statuses, or a status answer from a node that is behind (one RPC URL is load-balanced over
 * several nodes), could judge a not-found against a height the answering node had not reached; a transaction that
 * landed in that gap would be declared expired and replaced: a double trade. With both rules, every not-found was
 * seen by a node at least as far along as the height it is judged against.
 */
export const planStatusCheck = (
  effect: Extract<Effect, { type: 'check_status' }>,
  endpoints: LandingEndpoints,
): { readonly height: HttpCall; readonly statuses: HttpCall } => {
  if (effect.signatures.length === 0) throw new LandingError('no signatures to check');
  return {
    height: { path: 'rpc', url: endpoints.rpcUrl, body: rpc('getEpochInfo', [{ commitment: 'confirmed' }]) },
    statuses: { path: 'rpc', url: endpoints.rpcUrl, body: rpc('getSignatureStatuses', [effect.signatures, { searchTransactionHistory: effect.searchHistory }]) },
  };
};

/** A confirmed slot and the block height at it, read in one answer. */
export interface HeightPoint {
  readonly slot: bigint;
  readonly blockHeight: bigint;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Reads a `getEpochInfo` result. Anything but two non-negative integers is refused. */
export const heightPoint = (result: unknown): HeightPoint => {
  const r = result as { absoluteSlot?: unknown; blockHeight?: unknown } | null;
  if (r === null || typeof r !== 'object' || !isCount(r.absoluteSlot) || !isCount(r.blockHeight)) {
    throw new LandingError('getEpochInfo answered without an absolute slot and block height');
  }
  return { slot: BigInt(r.absoluteSlot), blockHeight: BigInt(r.blockHeight) };
};

/**
 * Lifecycle events from a `getSignatureStatuses` result judged against `at` (read before it). Null when the answering
 * node was behind `at.slot`: such an answer is no answer, and the lifecycle asks again on its next tick.
 */
export const statusEventsAt = (
  signatures: readonly Signature[],
  result: unknown,
  at: HeightPoint,
  searchedHistory: boolean,
): IntentEvent[] | null => {
  const r = result as { context?: { slot?: unknown }; value?: unknown } | null;
  if (r === null || typeof r !== 'object' || !isCount(r.context?.slot)) throw new LandingError('getSignatureStatuses answered without a context slot');
  if (!Array.isArray(r.value)) throw new LandingError('getSignatureStatuses answered without a value list');
  if (BigInt(r.context.slot) < at.slot) return null;
  return statusEvents(signatures, r.value as RpcSignatureStatus[], at.blockHeight, searchedHistory);
};

/** One entry of `getSignatureStatuses` `value[]` (null when the node does not know the signature). */
export type RpcSignatureStatus = {
  readonly slot: number;
  readonly err: unknown;
  readonly confirmationStatus: string | null;
} | null;

const COMMITMENTS: ReadonlySet<string> = new Set(['processed', 'confirmed', 'finalized']);

/**
 * Lifecycle `status` events, one per signature, in request order. `blockHeight` is the confirmed height read before
 * the statuses were requested, by a node no further along than the one that answered them (see planStatusCheck). An entry without a known commitment level is refused rather
 * than guessed.
 */
export const statusEvents = (
  signatures: readonly Signature[],
  values: readonly RpcSignatureStatus[],
  blockHeight: bigint,
  searchedHistory: boolean,
): IntentEvent[] => {
  if (values.length !== signatures.length) throw new LandingError(`asked for ${signatures.length} statuses, got ${values.length}`);
  return signatures.map((signature, i): IntentEvent => {
    const s = values[i];
    if (s === null || s === undefined) return { type: 'status', signature, result: 'not_found', commitment: null, blockHeight, searchedHistory };
    if (s.confirmationStatus === null || !COMMITMENTS.has(s.confirmationStatus)) throw new LandingError(`status of ${signature} has no known commitment level`);
    const commitment = s.confirmationStatus as Commitment;
    const failed = s.err !== null && s.err !== undefined;
    return { type: 'status', signature, result: failed ? 'failed' : 'succeeded', commitment, blockHeight, searchedHistory };
  });
};

/** The block-height poll that drives rebroadcast and expiry (CORE-1 `tick`). Heights are read at `confirmed`. */
export const planTick = (endpoints: LandingEndpoints): HttpCall => ({ path: 'rpc', url: endpoints.rpcUrl, body: rpc('getBlockHeight', [{ commitment: 'confirmed' }]) });

export const tickEvent = (blockHeight: bigint): IntentEvent => {
  if (blockHeight < 0n) throw new LandingError('block height is negative');
  return { type: 'tick', blockHeight };
};

/** A fresh blockhash for a first attempt or an allowed replacement, at `confirmed` (execution.md §4.4). */
export const planBlockhash = (endpoints: LandingEndpoints): HttpCall => ({ path: 'rpc', url: endpoints.rpcUrl, body: rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]) });

export type ReplacementCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether a replacement may be built and signed now. A new signature is a new trade: only after expiry or a
 * finalized failure is established, balances are reconciled with no fill, and every earlier attempt is dead at
 * `blockHeight`. CORE-1 refuses the `sign_replacement` event on the same grounds; this check runs first so no
 * replacement is even built (or sent to the signer) while an old blockhash can still land.
 */
export const replacementAllowed = (s: IntentState, blockHeight: bigint): ReplacementCheck => {
  if (!isResolvedUnfilled(s)) return { ok: false, reason: `intent is ${s.status}; a replacement needs a reconciled intent without a fill` };
  if (s.cancelRequested) return { ok: false, reason: 'cancel was requested' };
  const live = s.attempts.find((a) => !isAttemptDead(s, a, blockHeight));
  if (live) return { ok: false, reason: `attempt ${live.id} can still land until block height ${live.lastValidBlockHeight}` };
  return { ok: true };
};

/** A first attempt is signed only for a prepared intent with no earlier attempt. */
export const firstAttemptAllowed = (s: IntentState): ReplacementCheck =>
  s.status === 'prepared' && s.attempts.length === 0 ? { ok: true } : { ok: false, reason: `intent is ${s.status} with ${s.attempts.length} attempts` };
