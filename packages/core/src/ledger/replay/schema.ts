// The stored form of a book event in `intent_event.detail`: {"v":1,"book":<BookEvent>} (supervisor ruling,
// docs/DECISIONS.md). Checked strictly on write and on read: an unknown version, a missing or extra field, a
// wrong type, a non-canonical id or a negative amount is refused. A new field or variant needs a new version.
import { attemptId, blockhash, intentId, mint, positionId, reservationId, signature } from '../../domain/index.ts';
import type { BookEvent } from '../../lifecycle/index.ts';
import { LedgerError } from '../errors.ts';

export const BOOK_DETAIL_VERSION = 1;

type Check = (x: unknown, path: string) => void;

const bad = (path: string, what: string): never => {
  throw new LedgerError(`book event ${path}: ${what}`);
};

const plain = (x: unknown): x is Record<string, unknown> => {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

/** Exactly these own keys; those named in `optional` may be absent. */
const obj = (shape: Readonly<Record<string, Check>>, optional: readonly string[] = []): Check => (x, path) => {
  if (!plain(x)) return bad(path, 'must be a plain object');
  for (const k of Object.keys(x)) if (!Object.hasOwn(shape, k)) bad(`${path}.${k}`, 'unknown field');
  for (const [k, check] of Object.entries(shape)) {
    if (!Object.hasOwn(x, k)) {
      if (!optional.includes(k)) bad(`${path}.${k}`, 'missing');
      continue;
    }
    check(x[k], `${path}.${k}`);
  }
};

const lit = (...values: readonly (string | boolean)[]): Check => (x, path) => {
  if (!values.includes(x as string)) bad(path, `must be one of ${values.join(', ')}`);
};
const str: Check = (x, path) => {
  if (typeof x !== 'string' || x.length === 0) bad(path, 'must be a non-empty string');
};
const bool: Check = (x, path) => {
  if (typeof x !== 'boolean') bad(path, 'must be a boolean');
};
const amount: Check = (x, path) => {
  if (typeof x !== 'bigint' || x < 0n) bad(path, 'must be a bigint >= 0');
};
const int: Check = (x, path) => {
  if (!Number.isSafeInteger(x)) bad(path, 'must be a safe integer');
};
const nullable = (check: Check): Check => (x, path) => {
  if (x !== null) check(x, path);
};
const arr = (check: Check): Check => (x, path) => {
  if (!Array.isArray(x)) return bad(path, 'must be an array');
  x.forEach((v, i) => check(v, `${path}[${i}]`));
};
/** A domain constructor that throws on a malformed value. */
const via = (make: (text: string) => string): Check => (x, path) => {
  if (typeof x !== 'string') return bad(path, 'must be a string');
  try {
    if (make(x) !== x) bad(path, 'is not canonical');
  } catch (err) {
    bad(path, (err as Error).message);
  }
};
const iid = via(intentId);
const pid = via(positionId);
const sig = via(signature);
const commitment = lit('processed', 'confirmed', 'finalized');

const quote = obj({ provider: str, requestId: nullable(str), inAmount: amount, quotedOut: amount, minOut: amount, slippage: int, quotedAtSlot: nullable(amount) });
const attempt = obj({ id: via(attemptId), intentId: iid, signedBytesRef: str, signature: sig, blockhash: via(blockhash), lastValidBlockHeight: amount, quote });
const fill = obj({ intentId: iid, signature: sig, slot: amount, commitment: lit('confirmed', 'finalized'), tokens: amount, sol: amount, fees: amount });
const reservation = obj({ id: via(reservationId), intentId: iid, amount, status: lit('held', 'released', 'kept') });
const entryIntent = obj({ id: iid, key: str, purpose: lit('entry'), side: lit('buy'), mint: via(mint), venue: lit('pump-curve', 'pumpswap'), positionId: pid, spend: amount });
const exitReasons = arr(lit('stop', 'trailing_stop', 'take_profit', 'max_hold', 'thesis_lost', 'liquidity', 'emergency'));
const pauseReason = lit('daily_loss', 'session_loss', 'owner');

/** Checks by the `type` field, then by that variant's shape. */
const byType = (variants: Readonly<Record<string, Check>>): Check => (x, path) => {
  if (!plain(x) || typeof x['type'] !== 'string' || !Object.hasOwn(variants, x['type'])) return bad(`${path}.type`, `must be one of ${Object.keys(variants).join(', ')}`);
  variants[x['type']]!(x, path);
};

const intentEvent = byType({
  mark_eligible: obj({ type: str }),
  reject: obj({ type: str, reason: str }),
  approve_risk: obj({ type: str }),
  reserve_exposure: obj({ type: str, reservation }),
  prepare: obj({ type: str, quote }),
  sign: obj({ type: str, attempt }),
  submit: obj({ type: str }),
  send_accepted: obj({ type: str }),
  send_timeout: obj({ type: str }),
  send_error: obj({ type: str, message: str }),
  status: obj({ type: str, signature: sig, result: lit('succeeded', 'failed', 'not_found'), commitment: nullable(commitment), blockHeight: amount, searchedHistory: bool }),
  reconcile: obj({ type: str, fills: arr(fill), blockHeight: amount }),
  sign_replacement: obj({ type: str, attempt, blockHeight: amount }),
  abandon: obj({ type: str }),
  cancel: obj({ type: str }),
});

const bookEvent = byType({
  propose_entry: obj({ type: str, intent: entryIntent }),
  intent: obj({ type: str, intentId: iid, event: intentEvent }),
  orphan_fill: obj({ type: str, fill }),
  orphan_cleared: obj({
    type: str, signature: sig,
    proof: obj({ signature: sig, balances: lit('unchanged', 'changed'), commitment, status: lit('not_found', 'failed', 'succeeded'), searchedHistory: bool, finalizedBlockHeight: amount }),
  }),
  trigger_exit: obj({ type: str, positionId: pid, reasons: exitReasons, intentId: iid, quantity: amount }, ['quantity']),
  exit_blocked: obj({ type: str, positionId: pid, reason: str }),
  tick: obj({ type: str, blockHeight: amount }),
  restart: obj({ type: str }),
  pause_entries: obj({ type: str, reason: pauseReason }),
  resume_entries: obj({ type: str, reason: pauseReason }),
});

const detail = obj({ v: int, book: bookEvent });

/** The detail to store for a book event. Throws LedgerError if the event does not match the schema. */
export const encodeBookDetail = (e: BookEvent): { readonly v: number; readonly book: BookEvent } => {
  const d = { v: BOOK_DETAIL_VERSION, book: e };
  detail(d, 'detail');
  return d;
};

/** The book event in a stored detail. Throws LedgerError on an unknown version or anything off the schema. */
export const decodeBookDetail = (x: unknown): BookEvent => {
  if (plain(x) && x['v'] !== BOOK_DETAIL_VERSION) bad('detail.v', `unknown version ${String(x['v'])}; this code reads ${BOOK_DETAIL_VERSION}`);
  detail(x, 'detail');
  return (x as { book: BookEvent }).book;
};
