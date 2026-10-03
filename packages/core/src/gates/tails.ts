// GATE-1c: the 8 unpublished bytes the 2026-10-02 upgrade appends to trade events (UPG-1, venues.md §2.7). They are
// zero on every SOL-quoted market sampled; a non-zero tail, or a tail of the wrong length, on a market we would price
// means an unpublished field is live there, so that market is refused. No tail evidence is never a pass.
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

/**
 * Checks every trade event of the pool released between `fromMs` (migration) and now. Rejects on the first event, in
 * release order, whose tail is non-zero or of a length the boundary does not allow; refuses an unreadable event; and
 * is not covered when there is no trade event at all.
 */
export const checkPoolTails = (ctx: { readonly now: Moment; readonly history: GateContext['history'] }, pool: string, fromMs: number): TailCheck => {
  const entries: AsOfEntry[] = [];
  for (const key of poolTradeKeys(pool)) {
    const h = ctx.history(key, ORIGIN, ctx.now);
    if (!Array.isArray(h)) return { ok: false, code: 'not-covered', detail: `trade history of ${pool} refused` };
    entries.push(...(h as readonly AsOfEntry[]).filter((e) => e.moment.receivedAt >= fromMs));
  }
  entries.sort((a, b) => (a.moment.slot < b.moment.slot ? -1 : a.moment.slot > b.moment.slot ? 1 : 0)
    || a.moment.txIndex - b.moment.txIndex || a.moment.ixIndex - b.moment.ixIndex || a.moment.receivedAt - b.moment.receivedAt
    || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  if (entries.length === 0) return { ok: false, code: 'not-covered', detail: `no trade event of pool ${pool} since migration` };
  for (const e of entries) {
    const v = isObj(e.value) ? e.value : null;
    const ev = v !== null && isObj(v['event']) ? v['event'] : null;
    const slot = v?.['txSlot'];
    if (v === null || ev === null || typeof ev['trailing'] !== 'number' || typeof ev['extra'] !== 'string' || typeof slot !== 'bigint') {
      return { ok: false, code: 'malformed', detail: `trade event ${e.source} of pool ${pool} has no readable tail`, signature: v === null ? e.source : signatureOf(e, v) };
    }
    const signature = signatureOf(e, v);
    const trailing = ev['trailing'];
    const extra = ev['extra'];
    const allowed = allowedLengths('pump_amm', slot);
    if (!allowed.includes(trailing) || extra.length !== 2 * trailing) {
      return { ok: false, code: 'event-tail', signature, detail: `trade event tail is ${trailing} bytes at slot ${slot}; the upgrade boundary allows ${allowed.join(' or ')} (first offending signature ${signature})` };
    }
    if (/[^0]/.test(extra)) {
      return { ok: false, code: 'event-tail', signature, detail: `trade event tail is non-zero (${extra}) on a SOL-quoted pool (first offending signature ${signature})` };
    }
  }
  return { ok: true, events: entries.length };
};
