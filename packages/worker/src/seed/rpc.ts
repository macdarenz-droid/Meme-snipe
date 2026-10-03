// SEED-1 source 2: an RPC backfill of pump creates from the dataset's last slot to the process start.
// `getSignaturesForAddress` on the pump create authority (it signs as mint authority in every create, so its history
// is exactly the creates) gives signatures newest first; each successful one is fetched with `getTransaction` at
// `confirmed` and decoded only by DEC-1's `transactionEvents`, so a seeded create is the same event FEED-1 emits live.
//
// Fail safe throughout. Every call goes through the provider's quota scheduler at P3 (FEED-1's 70% halt applies)
// and inside this run's own credit cap. Transient errors (rate limits, timeouts, 5xx, a refused queue slot) back off
// exponentially, a bounded number of times. A transaction that cannot be read, or reads without a decodable create,
// leaves a one-slot gap; a page that cannot be read, the cap or the halt stops the run, and everything older than
// what was done stays a gap. Work goes newest first, so a stopped run leaves its gap at the old end of the look-back,
// which ages out of H14's window first. Nothing after `untilSlot` is kept: a signature newer than the process start is
// dropped before its transaction is fetched.
import { transactionEvents, type TransactionRecord } from '../../../core/src/chain/index.ts';
import type { MarketEvent } from '../../../core/src/engine/index.ts';
import { SECOND_MS } from '../../../core/src/config/time.ts';
import { TX_CREATE_PREFIX } from '../../../core/src/gates/index.ts';
import { eventIxIndex, LIVE_TX_BASE } from '../providers/canonical.ts';
import { ProviderError } from '../providers/http.ts';
import { callCost, type SignatureInfo } from '../providers/solana-http.ts';
import { P3, ScheduleRefused, type Priority } from '../scheduler/scheduler.ts';
import type { Timers } from '../scheduler/timers.ts';

/** pump's mint authority PDA: a signer-free account in every create (checked on mainnet 2026-10-04: CreateV2). */
export const PUMP_CREATE_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
export const SIGNATURE_PAGE = 1000;

/** The two calls the backfill makes. `RpcHttp` is one; every call it makes goes through its scheduler. */
export interface SeedRpc {
  getSignaturesForAddress(address: string, opts: { readonly before?: string; readonly limit: number; readonly minContextSlot?: bigint }, priority: Priority): Promise<SignatureInfo[]>;
  getTransaction(signature: string, priority: Priority): Promise<TransactionRecord | null>;
}

export interface RetryPolicy {
  /** Attempts per call, the first included. */
  readonly attempts: number;
  readonly baseMs: number;
  readonly maxMs: number;
  /** Consecutive unreadable transactions after which the run stops (the provider is failing, not one transaction). */
  readonly maxConsecutiveFailures: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseMs: 2_000, maxMs: 16_000, maxConsecutiveFailures: 20 };

export interface BackfillOptions {
  readonly rpc: SeedRpc;
  readonly timers: Timers;
  /** Slots after this one are backfilled; it is the last slot the days covered (exclusive bound). */
  readonly afterSlot: bigint;
  /** The last slot backfilled: the live creates watch's coverage start (inclusive bound). */
  readonly untilSlot: bigint;
  /** Credits (or compute units) this run may spend. The scheduler's own monthly halt applies on top. */
  readonly creditCap: number;
  /** The provider `rpc` calls: each call is charged its `callCost`. */
  readonly provider: 'helius' | 'alchemy';
  readonly retry?: RetryPolicy;
}

export interface SlotGap {
  readonly fromSlot: bigint;
  readonly toSlot: bigint;
  /** Block time (ms) at or after the gap's end, when known. */
  readonly atMs: number | null;
  readonly reason: string;
}

export type StopReason = 'done' | 'credit-cap' | 'halted' | 'page-failed' | 'failures' | 'history-end' | 'not-confirmed';

export interface BackfillResult {
  /** Create events in FEED-1's shape, oldest first. */
  readonly creates: readonly MarketEvent[];
  /** Earliest block time (ms) seen in the range, for the coverage start; null when nothing was seen. */
  readonly firstMs: number | null;
  readonly gaps: readonly SlotGap[];
  readonly calls: { readonly getSignaturesForAddress: number; readonly getTransaction: number };
  readonly creditsUsed: number;
  readonly retries: number;
  readonly droppedFuture: number;
  readonly stoppedBy: StopReason;
}

class Stop extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** JSON-RPC -32016: the node's `confirmed` bank is still below `minContextSlot`. */
const notConfirmedYet = (e: unknown): boolean => e instanceof ProviderError && e.kind === 'rpc' && /error -32016$/.test(e.message);

const transient = (e: unknown): boolean => notConfirmedYet(e) ||
  (e instanceof ProviderError && (e.kind === 'rate_limited' || e.kind === 'timeout' || e.kind === 'network' || (e.kind === 'http' && (e.status ?? 0) >= 500)))
  || (e instanceof ScheduleRefused && e.reason !== 'halted');

const sleep = (timers: Timers, ms: number): Promise<void> => new Promise((resolve) => { timers.setTimeout(resolve, ms); });

const pad = (n: number): string => String(n).padStart(5, '0');

/** The create events of one fetched transaction, as FEED-1's `eventsOfFrame` builds them for a `tx` frame. */
export const createEventsOf = (r: TransactionRecord, rank: number, seq: number): MarketEvent[] =>
  transactionEvents(r).flatMap((e): MarketEvent[] => {
    if (e.name !== 'CreateEvent' || e.program !== 'pump') return [];
    return [{
      kind: 'market', id: `ev:${r.signature}:${pad(e.outerIx)}:${pad(e.innerIx)}`,
      moment: { slot: r.slot, txIndex: LIVE_TX_BASE + rank, ixIndex: eventIxIndex(e.outerIx, e.innerIx), receivedAt: (r.blockTime ?? 0) * SECOND_MS },
      key: `${TX_CREATE_PREFIX}${e.data.mint}`,
      value: { event: e, txSlot: r.slot, blockTime: r.blockTime, source: 'seed', backfilled: true, seq },
    }];
  });

export const backfillCreates = async (o: BackfillOptions): Promise<BackfillResult> => {
  const retry = o.retry ?? DEFAULT_RETRY;
  const calls = { getSignaturesForAddress: 0, getTransaction: 0 };
  let credits = 0;
  let retries = 0;
  let droppedFuture = 0;
  const creates: MarketEvent[] = [];
  const gaps: SlotGap[] = [];
  let firstMs: number | null = null;

  const call = async <T>(method: keyof typeof calls, run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      const cost = callCost(o.provider, method);
      if (credits + cost > o.creditCap) throw new Stop('credit-cap', `credit cap ${o.creditCap} reached after ${credits}`);
      credits += cost; // counted per attempt: a failed call may still be billed
      calls[method]++;
      try {
        return await run();
      } catch (e) {
        if (e instanceof ScheduleRefused && e.reason === 'halted') throw new Stop('halted', 'the provider budget reached its halt share');
        if (!transient(e) || attempt >= retry.attempts) throw e;
        retries++;
        await sleep(o.timers, Math.min(retry.maxMs, retry.baseMs * 2 ** (attempt - 1)));
      }
    }
  };

  // The newest slot not yet fully done: everything from afterSlot+1 to it is still owed.
  let owedTo = o.untilSlot;
  let owedAtMs: number | null = null;
  let stoppedBy: StopReason = 'done';
  let before: string | undefined;
  let failures = 0;
  let seq = 0;
  const ranks = new Map<bigint, number>();
  try {
    paging: for (;;) {
      let page: SignatureInfo[];
      // The first page waits until the node's confirmed bank has reached untilSlot (minContextSlot), so the slots
      // just before the live watch's start are not missed while they are only processed.
      const first = before === undefined;
      try {
        page = await call('getSignaturesForAddress', () => o.rpc.getSignaturesForAddress(PUMP_CREATE_AUTHORITY, before === undefined ? { limit: SIGNATURE_PAGE, minContextSlot: o.untilSlot } : { before, limit: SIGNATURE_PAGE }, P3));
      } catch (e) {
        if (e instanceof Stop) throw e;
        if (first && notConfirmedYet(e)) throw new Stop('not-confirmed', `confirmed never reached slot ${o.untilSlot}`);
        throw new Stop('page-failed', `signature page failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const s of page) {
        if (s.slot > o.untilSlot) {
          droppedFuture++; // newer than the process start: never fetched, never seeded
          continue;
        }
        if (s.slot <= o.afterSlot) break paging;
        const ms = s.blockTime === null ? null : s.blockTime * SECOND_MS;
        if (ms !== null) firstMs = firstMs === null ? ms : Math.min(firstMs, ms);
        // Signatures of a slot newer than this one are all done.
        if (s.slot < owedTo) {
          owedTo = s.slot;
          owedAtMs = ms;
        }
        if (s.err !== null) continue; // a failed create made no mint
        let read: MarketEvent[] | string;
        try {
          const r = await call('getTransaction', () => o.rpc.getTransaction(s.signature, P3));
          if (r === null) read = 'not available at confirmed';
          else if (r.slot !== s.slot) read = `transaction slot ${r.slot} differs from its signature's ${s.slot}`;
          else if (r.blockTime === null) read = 'no block time';
          else {
            const rank = ranks.get(s.slot) ?? 0;
            ranks.set(s.slot, rank + 1);
            read = createEventsOf(r, rank, seq++);
            if (read.length === 0) read = 'no decodable CreateEvent';
          }
        } catch (e) {
          if (e instanceof Stop) throw e;
          read = e instanceof Error ? e.message : String(e);
        }
        if (typeof read === 'string') {
          gaps.push({ fromSlot: s.slot, toSlot: s.slot, atMs: ms, reason: `${s.signature}: ${read}` });
          if (++failures >= retry.maxConsecutiveFailures) throw new Stop('failures', `${failures} transactions in a row could not be read`);
        } else {
          failures = 0;
          creates.push(...read);
        }
      }
      // A short or empty page is the end of the address's history: done only once afterSlot was reached (above).
      if (page.length < SIGNATURE_PAGE) throw new Stop('history-end', `history ended at slot ${owedTo} before slot ${o.afterSlot + 1n}`);
      before = page[page.length - 1]!.signature;
    }
    owedTo = o.afterSlot; // done: nothing owed
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    stoppedBy = e.reason;
    gaps.push({ fromSlot: o.afterSlot + 1n, toSlot: owedTo, atMs: owedAtMs, reason: `backfill stopped (${e.reason}): ${e.message}` });
  }
  // Fetched newest first; within a slot, signatures came newest first too, so ranks are re-numbered oldest first.
  const bySlot = new Map<bigint, number>();
  for (const e of creates) bySlot.set(e.moment.slot, Math.max(bySlot.get(e.moment.slot) ?? 0, e.moment.txIndex - LIVE_TX_BASE));
  const ordered = creates.map((e) => ({ ...e, moment: { ...e.moment, txIndex: LIVE_TX_BASE + (bySlot.get(e.moment.slot)! - (e.moment.txIndex - LIVE_TX_BASE)) } }))
    .sort((a, b) => (a.moment.slot < b.moment.slot ? -1 : a.moment.slot > b.moment.slot ? 1 : 0) || a.moment.txIndex - b.moment.txIndex || a.moment.ixIndex - b.moment.ixIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { creates: ordered, firstMs, gaps, calls, creditsUsed: credits, retries, droppedFuture, stoppedBy };
};
