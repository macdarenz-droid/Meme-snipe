// Shared domain types. Pure data and validation: no I/O, no clocks, no randomness.
// Every chain quantity uses the exact-amount types from units; floats never touch money.

import type { Bps, Lamports, RawAmount } from '../units/index.ts';

declare const brand: unique symbol;
type Brand<B, T extends string> = B & { readonly [brand]: T };

// ---------- Base58 identifiers ----------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Number of bytes a base58 string decodes to, or null if it is not base58. Leading '1's are leading zero bytes. */
export const base58ByteLength = (text: string): number | null => {
  if (text.length === 0) return null;
  let n = 0n;
  for (const ch of text) {
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  let bytes = 0;
  while (n > 0n) {
    n >>= 8n;
    bytes++;
  }
  return zeros + bytes;
};

/** A 32-byte public key (base58, 32 to 44 characters). */
export type Address = Brand<string, 'address'>;
export type Mint = Brand<string, 'mint'>;
export type PoolAddress = Brand<string, 'pool'>;
export type WalletAddress = Brand<string, 'wallet'>;
/** A 32-byte recent blockhash. */
export type Blockhash = Brand<string, 'blockhash'>;
/** A 64-byte transaction signature (base58, 64 to 88 characters). */
export type Signature = Brand<string, 'signature'>;

const expectBytes = (text: string, bytes: number, maxChars: number, what: string): string => {
  if (typeof text !== 'string' || text.length > maxChars || base58ByteLength(text) !== bytes) {
    throw new RangeError(`${what} must be base58 of exactly ${bytes} bytes, got "${String(text).slice(0, 100)}"`);
  }
  return text;
};

export const mint = (text: string): Mint => expectBytes(text, 32, 44, 'mint') as Mint;
export const poolAddress = (text: string): PoolAddress => expectBytes(text, 32, 44, 'pool address') as PoolAddress;
export const walletAddress = (text: string): WalletAddress => expectBytes(text, 32, 44, 'wallet address') as WalletAddress;
export const blockhash = (text: string): Blockhash => expectBytes(text, 32, 44, 'blockhash') as Blockhash;
export const signature = (text: string): Signature => expectBytes(text, 64, 88, 'signature') as Signature;

export const isMint = (text: string): text is Mint => text.length <= 44 && base58ByteLength(text) === 32;
export const isSignature = (text: string): text is Signature => text.length <= 88 && base58ByteLength(text) === 64;

// ---------- Local identifiers and idempotency keys ----------

export type IntentId = Brand<string, 'intent-id'>;
export type PositionId = Brand<string, 'position-id'>;
export type AttemptId = Brand<string, 'attempt-id'>;
export type ReservationId = Brand<string, 'reservation-id'>;
/** A unique key per economic decision. Storing it under a unique constraint makes a retried decision a no-op. */
export type IdempotencyKey = Brand<string, 'idempotency-key'>;

const LOCAL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const localId = (text: string, what: string): string => {
  if (!LOCAL_ID.test(text)) throw new RangeError(`${what} must be 1..128 chars of [A-Za-z0-9_.:-], got "${text}"`);
  return text;
};

export const intentId = (text: string): IntentId => localId(text, 'intent id') as IntentId;
export const positionId = (text: string): PositionId => localId(text, 'position id') as PositionId;
export const attemptId = (text: string): AttemptId => localId(text, 'attempt id') as AttemptId;
export const reservationId = (text: string): ReservationId => localId(text, 'reservation id') as ReservationId;

/** One entry per (mint, decision): the same decision replayed yields the same key. */
export const entryKey = (token: Mint, decisionId: string): IdempotencyKey =>
  `entry:${token}:${localId(decisionId, 'decision id')}` as IdempotencyKey;

/** One key per exit owner of a position: `seq` counts exit owners (1, 2, ...), never attempts. */
export const exitKey = (position: PositionId, seq: number): IdempotencyKey => {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`exit sequence must be an integer >= 1, got ${seq}`);
  return `exit:${position}:${seq}` as IdempotencyKey;
};

// ---------- Venues and chain context ----------

export type Venue = 'pump-curve' | 'pumpswap';
export const VENUES: readonly Venue[] = ['pump-curve', 'pumpswap'];

export type Commitment = 'processed' | 'confirmed' | 'finalized';

// ---------- Observations and freshness ----------

/** Evidence kinds with their own freshness budget (architecture: "Data collection and quality rules"). */
export type EvidenceKind =
  | 'mint-authority'
  | 'freeze-authority'
  | 'token-extensions'
  | 'pool-state'
  | 'quote'
  | 'trades'
  | 'holders'
  | 'deployer-history'
  | 'liquidity'
  | 'network-fees';

export type QualityFlag =
  | 'backfilled'
  | 'deduplicated'
  | 'partial'
  | 'estimated'
  | 'fork-suspect'
  | 'rate-limited'
  | 'provider-degraded';

export interface Provenance {
  readonly provider: string;
  readonly mint: Mint;
  readonly pool: PoolAddress | null;
  /** Chain slot the value was read at; null when the provider gives none. */
  readonly slot: bigint | null;
  /** When the fact happened (ms since epoch, integer). */
  readonly eventTime: number;
  /** When this process received it (ms since epoch, integer). */
  readonly receivedAt: number;
  readonly commitment: Commitment;
  readonly quality: readonly QualityFlag[];
}

export interface Observation<T> {
  readonly kind: EvidenceKind;
  readonly value: T;
  readonly provenance: Provenance;
}

/** Maximum age in ms per evidence kind. A kind without a budget can never be fresh. */
export type FreshnessBudgets = Partial<Readonly<Record<EvidenceKind, number>>>;

export type FreshnessFailure = 'missing' | 'no-budget' | 'invalid-time' | 'from-future' | 'stale';
export type Freshness =
  | { readonly fresh: true; readonly ageMs: number }
  | { readonly fresh: false; readonly reason: FreshnessFailure; readonly ageMs: number | null };

/**
 * Is this observation fresh enough to act on at `nowMs`? Age and timestamps only: quality flags and
 * commitment are judged by the evidence gates (docs/DECISIONS.md), so fresh alone does not mean usable.
 * Missing evidence, a kind without a budget,
 * non-integer or inconsistent times, a timestamp from the future and an over-age value all fail.
 * Age is measured from eventTime (when the fact happened), not from receipt.
 * `futureToleranceMs` absorbs clock skew; Solana block times have one-second resolution, so the default is 1,000 ms.
 */
export const checkFreshness = (
  observation: Observation<unknown> | null | undefined,
  nowMs: number,
  budgets: FreshnessBudgets,
  futureToleranceMs = 1_000,
): Freshness => {
  if (observation == null) return { fresh: false, reason: 'missing', ageMs: null };
  const budget = budgets[observation.kind];
  if (budget === undefined || !Number.isSafeInteger(budget) || budget < 0) return { fresh: false, reason: 'no-budget', ageMs: null };
  const { eventTime, receivedAt } = observation.provenance;
  if (!Number.isSafeInteger(eventTime) || !Number.isSafeInteger(receivedAt) || !Number.isSafeInteger(nowMs)) {
    return { fresh: false, reason: 'invalid-time', ageMs: null };
  }
  const ageMs = nowMs - eventTime;
  if (eventTime > receivedAt + futureToleranceMs || receivedAt > nowMs + futureToleranceMs || ageMs < -futureToleranceMs) {
    return { fresh: false, reason: 'from-future', ageMs };
  }
  if (ageMs > budget) return { fresh: false, reason: 'stale', ageMs };
  return { fresh: true, ageMs: Math.max(0, ageMs) };
};

// ---------- Trading records ----------

export interface EntryIntent {
  readonly id: IntentId;
  readonly key: IdempotencyKey;
  readonly purpose: 'entry';
  readonly side: 'buy';
  readonly mint: Mint;
  readonly venue: Venue;
  readonly positionId: PositionId;
  /** SOL to spend, before network fees. */
  readonly spend: Lamports;
}

export interface ExitIntent {
  readonly id: IntentId;
  readonly key: IdempotencyKey;
  readonly purpose: 'exit';
  readonly side: 'sell';
  readonly mint: Mint;
  readonly venue: Venue;
  readonly positionId: PositionId;
  /** Tokens to sell; never more than the position's available quantity. */
  readonly quantity: RawAmount;
}

export type TradeIntent = EntryIntent | ExitIntent;

/** What the route promised when the transaction was built. Used to judge the fill, never as the fill. */
export interface QuoteContext {
  readonly provider: string;
  /** Aggregator request id (Jupiter /order), when the route has one. */
  readonly requestId: string | null;
  readonly inAmount: bigint;
  readonly quotedOut: bigint;
  readonly minOut: bigint;
  readonly slippage: Bps;
  readonly quotedAtSlot: bigint | null;
}

/** One signed transaction for an intent. Persisted before the first broadcast. */
export interface TransactionAttempt {
  readonly id: AttemptId;
  readonly intentId: IntentId;
  /** Reference to the stored signed bytes (for example a content hash). Rebroadcasts send exactly these bytes. */
  readonly signedBytesRef: string;
  readonly signature: Signature;
  readonly blockhash: Blockhash;
  /** The attempt can never land once the confirmed block height exceeds this. */
  readonly lastValidBlockHeight: bigint;
  readonly quote: QuoteContext;
}

/** A fill measured from actual balance changes, never from the quote. */
export interface Fill {
  readonly intentId: IntentId;
  readonly signature: Signature;
  readonly slot: bigint;
  readonly commitment: 'confirmed' | 'finalized';
  /** Tokens bought (entry) or sold (exit). */
  readonly tokens: RawAmount;
  /** SOL spent (entry) or received (exit), excluding network fees. */
  readonly sol: Lamports;
  /** Network fees paid, including priority fee and tips. */
  readonly fees: Lamports;
}

export interface Position {
  readonly id: PositionId;
  readonly mint: Mint;
  readonly venue: Venue;
  readonly entryIntentId: IntentId;
  /** Confirmed tokens still held. */
  readonly quantity: RawAmount;
  /** SOL spent on entry. */
  readonly cost: Lamports;
}

export interface ExposureReservation {
  readonly id: ReservationId;
  readonly intentId: IntentId;
  readonly amount: Lamports;
  /** held: counts against limits; released: returned unused; kept: converted into an open position. */
  readonly status: 'held' | 'released' | 'kept';
}
