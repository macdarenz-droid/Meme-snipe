// Deterministic test fixtures: valid base58 keys and signatures, and builders for lifecycle records.
import { bps, lamports, raw } from '../src/units/index.ts';
import {
  attemptId, blockhash, entryKey, intentId, mint, positionId, reservationId, signature,
  type EntryIntent, type Fill, type IntentId, type QuoteContext, type TransactionAttempt,
} from '../src/domain/index.ts';
import { applyBookEvent, isIllegal, type Book, type BookEvent, type Effect } from '../src/lifecycle/index.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const base58Encode = (bytes: Uint8Array): string => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
};

const bytesFrom = (seed: number, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 255;
  }
  out[0] = (out[0]! % 255) + 1; // no leading zero byte, so lengths stay typical
  return out;
};

const memo = <T>(make: (seed: number) => T) => {
  const cache = new Map<number, T>();
  return (seed: number): T => {
    let v = cache.get(seed);
    if (v === undefined) cache.set(seed, (v = make(seed)));
    return v;
  };
};

export const key32 = memo((seed) => base58Encode(bytesFrom(seed, 32)));
export const sig = memo((seed) => signature(base58Encode(bytesFrom(seed + 1_000_000, 64))));
const hash = memo((seed) => blockhash(key32(5_000 + seed)));
export const blockhashOf = hash;

export const MINT = mint(key32(1));
/** The trial setting from docs/ARCHITECTURE.md: one open position. */
export const CONFIG = { maxOpenPositions: 1 };
export const SPEND = lamports(16_000_000);

export const quote: QuoteContext = {
  provider: 'test', requestId: null, inAmount: SPEND, quotedOut: 1_000_000n, minOut: 900_000n, slippage: bps(1000), quotedAtSlot: null,
};

export const entryIntent = (n: number, decision = `d${n}`): EntryIntent => ({
  id: intentId(`e${n}`), key: entryKey(MINT, decision), purpose: 'entry', side: 'buy',
  mint: MINT, venue: 'pump-curve', positionId: positionId(`p${n}`), spend: SPEND,
});

export const reservation = (id: IntentId, amount = SPEND) => ({ id: reservationId(`r-${id}`), intentId: id, amount, status: 'held' as const });

export const attempt = (id: IntentId, n: number, lastValidBlockHeight: bigint): TransactionAttempt => ({
  id: attemptId(`a${n}`), intentId: id, signedBytesRef: `bytes-${n}`, signature: sig(n),
  blockhash: hash(n), lastValidBlockHeight, quote,
});

export const fill = (id: IntentId, n: number, tokens: bigint, sol: bigint = SPEND): Fill => ({
  intentId: id, signature: sig(n), slot: 100n, commitment: 'confirmed', tokens: raw(tokens), sol: lamports(sol), fees: lamports(10_000),
});

export interface Run { book: Book; effects: Effect[] }

/** Apply events that must all be legal; throws with the refusal otherwise. */
export const run = (book: Book, events: readonly BookEvent[], log: Effect[] = []): Run => {
  let b = book;
  for (const e of events) {
    const r = applyBookEvent(b, e);
    if (isIllegal(r)) throw new Error(`illegal ${e.type}/${'event' in e ? e.event.type : ''}: ${r.reason} (from ${r.from})`);
    b = r.state;
    log.push(...r.effects);
  }
  return { book: b, effects: log };
};

export const on = (id: IntentId, event: Extract<BookEvent, { type: 'intent' }>['event']): BookEvent => ({ type: 'intent', intentId: id, event });

/** Entry events from proposal up to and including submit. */
export const entryToSubmitted = (n: number, lastValid: bigint): BookEvent[] => {
  const i = entryIntent(n);
  return [
    { type: 'propose_entry', intent: i },
    on(i.id, { type: 'mark_eligible' }),
    on(i.id, { type: 'approve_risk' }),
    on(i.id, { type: 'reserve_exposure', reservation: reservation(i.id) }),
    on(i.id, { type: 'prepare', quote }),
    on(i.id, { type: 'sign', attempt: attempt(i.id, n, lastValid) }),
    on(i.id, { type: 'submit' }),
  ];
};
