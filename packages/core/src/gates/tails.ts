// GATE-1c: the 8 unpublished bytes the 2026-10-02 upgrade appends to trade events (UPG-1, venues.md §2.7). They were
// zero on every SOL-quoted market sampled on 2-3 Oct; on 6 Oct they were non-zero on most pools sampled (supervisor's
// crash hunt, F1). A non-zero tail, or a tail of the wrong length, on a market we would price means an unpublished
// field is live there, so that market is refused. No tail evidence is never a pass.
import { EVENT_TAIL_BYTES, EVENT_TAIL_UPGRADE_SLOT } from '../config/chain-upgrades.ts';
import type { AsOfEntry } from '../engine/asof.ts';
import type { Moment } from '../engine/moment.ts';
import type { GateContext } from './evidence.ts';

/** FEED-1 keys of a PumpSwap pool's trade events: decoded from fetched transactions, and from the logs stream. */
export const poolTradeKeys = (pool: string): readonly string[] =>
  ['BuyEvent', 'SellEvent'].flatMap((name) => [`pump_amm:${name}:${pool}`, `logs:pump_amm:${name}:${pool}`]);

const ORIGIN: Moment = { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER };

export type TailCheck =
  | { readonly ok: true; readonly events: number }
  | { readonly ok: false; readonly code: 'event-tail' | 'not-covered' | 'malformed'; readonly detail: string; readonly signature?: string };

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The transaction signature of an entry: the logs value names it; a fetched transaction's event id is `ev:<signature>:…`. */
const signatureOf = (e: AsOfEntry, v: Obj): string =>
  typeof v['signature'] === 'string' ? v['signature'] : e.source.startsWith('ev:') ? (e.source.slice(3).split(':')[0] ?? e.source) : e.source;

/** The tail length a trade event of `program` must have at `slot`: 0 before the upgrade, 8 after, either in its own slot. */
const allowedLengths = (program: keyof typeof EVENT_TAIL_UPGRADE_SLOT, slot: bigint): readonly number[] => {
  const b = EVENT_TAIL_UPGRADE_SLOT[program];
  return slot < b ? [0] : slot > b ? [EVENT_TAIL_BYTES] : [0, EVENT_TAIL_BYTES];
};

/** FEED-1 keys of a mint's bonding-curve trade events (pump `TradeEvent`). */
export const curveTradeKeys = (mint: string): readonly string[] => [`pump:TradeEvent:${mint}`, `logs:pump:TradeEvent:${mint}`];

/** Where the pool's tape starts: the migration event's slot when the migration fact has one, else its time. */
export interface Since {
  readonly slot: bigint | null;
  readonly ms: number;
}

type Program = keyof typeof EVENT_TAIL_UPGRADE_SLOT;

/**
 * Checks every trade event under `keys` released as of now (and since `since`, when given), in release order.
 * Rejects when any tail is non-zero or of a length the `program`'s boundary does not allow (naming the earliest);
 * else refuses an unreadable event (the earliest) or a refused history; with `required`, no event at all is not covered.
 */
const checkTape = (
  ctx: { readonly now: Moment; readonly history: GateContext['history'] }, keys: readonly string[], program: Program,
  since: Since | null, required: boolean, what: string,
): TailCheck => {
  const entries: AsOfEntry[] = [];
  for (const key of keys) {
    const h = ctx.history(key, ORIGIN, ctx.now);
    if (!Array.isArray(h)) return { ok: false, code: 'not-covered', detail: `trade history of ${what} refused` };
    entries.push(...(h as readonly AsOfEntry[]).filter((e) =>
      since === null || (since.slot !== null ? e.moment.slot >= since.slot : e.moment.receivedAt >= since.ms)));
  }
  entries.sort((a, b) => (a.moment.slot < b.moment.slot ? -1 : a.moment.slot > b.moment.slot ? 1 : 0)
    || a.moment.txIndex - b.moment.txIndex || a.moment.ixIndex - b.moment.ixIndex || a.moment.receivedAt - b.moment.receivedAt
    || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  if (entries.length === 0) {
    return required ? { ok: false, code: 'not-covered', detail: `no trade event of ${what} since migration` } : { ok: true, events: 0 };
  }
  // F1 (facts review B1): the answer does not depend on the order across kinds: any wrong or non-zero tail in range
  // rejects (`event-tail`, H5); else any unreadable one refuses (`malformed`, H16), each named by its earliest entry.
  let malformed: Exclude<TailCheck, { readonly ok: true }> | null = null;
  for (const e of entries) {
    const failed = tailVerdict(e, program, what);
    if (failed === null) continue;
    if (failed.code === 'event-tail') return failed;
    malformed ??= failed;
  }
  return malformed ?? { ok: true, events: entries.length };
};

/**
 * One trade event's tail against the boundary: null when it passes; else the failure (`malformed` for an event with no
 * readable tail, `event-tail` for a wrong length or non-zero bytes). The check and the store's collapse both use it.
 */
const tailVerdict = (e: AsOfEntry, program: Program, what: string): Exclude<TailCheck, { readonly ok: true }> | null => {
  const v = isObj(e.value) ? e.value : null;
  const ev = v !== null && isObj(v['event']) ? v['event'] : null;
  const slot = v?.['txSlot'];
  if (v === null || ev === null || typeof ev['trailing'] !== 'number' || typeof ev['extra'] !== 'string' || typeof slot !== 'bigint') {
    return { ok: false, code: 'malformed', detail: `trade event ${e.source} of ${what} has no readable tail`, signature: v === null ? e.source : signatureOf(e, v) };
  }
  const signature = signatureOf(e, v);
  const trailing = ev['trailing'];
  const extra = ev['extra'];
  const allowed = allowedLengths(program, slot);
  if (!allowed.includes(trailing) || extra.length !== 2 * trailing) {
    return { ok: false, code: 'event-tail', signature, detail: `${what} trade event tail is ${trailing} bytes at slot ${slot}; the upgrade boundary allows ${allowed.join(' or ')} (first offending signature ${signature})` };
  }
  if (/[^0]/.test(extra)) {
    return { ok: false, code: 'event-tail', signature, detail: `${what} trade event tail is non-zero (${extra}) on a SOL-quoted market (first offending signature ${signature})` };
  }
  return null;
};

/** A trade-event key's program (`poolTradeKeys`, `curveTradeKeys`), or null for any other key. */
const TRADE_KEY = /^(?:logs:)?(pump_amm):(?:BuyEvent|SellEvent):|^(?:logs:)?(pump):TradeEvent:/;

/**
 * OOM-SWAPS, F1 (supervisor ruling): the store keeps, of a trade-event key, its newest entry and, of the entries whose
 * tail would fail the check, per kind (`event-tail`, `malformed`) the earliest, the latest in order and the one received
 * last (`Collapse`), so at most eight entries a key. `checkTape` gives the same verdict (pass, `event-tail` for H5,
 * `malformed` or not covered for H16) from that subset for any `since`: it answers by kind, not by order across kinds
 * (facts review B1), and per kind an entry in range exists exactly when the latest of that kind in order (a slot since)
 * or the one received last (a time since) does; an entry at all, when the newest or the latest received does. The
 * entry it names is exact for a since at or before the key's first entry (the migration). The event count it returns is not read by any gate. Before F1 every failing entry stayed; since non-zero
 * tails became common on mainnet (2026-10-06), that was every swap, about 3 KB each, and the worker's heap ran out in
 * minutes (the backtest feed keeps its own subset, sim/facts.ts).
 */
export const tradeTailCollapse = (key: string): ((older: AsOfEntry) => boolean | string) | null => {
  const m = TRADE_KEY.exec(key);
  if (m === null) return null;
  const program: Program = m[1] !== undefined ? 'pump_amm' : 'pump';
  return (older) => tailVerdict(older, program, key)?.code ?? false;
};

type Ctx = { readonly now: Moment; readonly history: GateContext['history'] };

/** The pool's trade events since migration: required (no event since migration is not covered). */
export const checkPoolTails = (ctx: Ctx, pool: string, since: Since): TailCheck => checkTape(ctx, poolTradeKeys(pool), 'pump_amm', since, true, `pool ${pool}`);

/** The mint's own curve tape (before migration): every event that is there must pass; none is not a failure. */
export const checkCurveTails = (ctx: Ctx, mint: string): TailCheck => checkTape(ctx, curveTradeKeys(mint), 'pump', null, false, `curve of ${mint}`);
